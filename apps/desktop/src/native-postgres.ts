import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { createRequire as createModuleRequire } from "node:module";
import path from "node:path";
import { allocateLoopbackPort } from "./local-stack.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";
import { DESKTOP_APP_NAME } from "./user-data-name.js";

export const PG_BIN_DIR_ENV = "RAKAZO_PG_BIN_DIR";
export const PG_DIR_NAME = "pg";
export const PG_DATA_DIR_NAME = "data";
const PID_FILE_NAME = "postmaster.pid";
export const PG_OWNER_ROLE = "rakazo";
export const PG_APP_ROLE = "rakazo_app";
export const PG_DATABASE = "rakazo";
export const PG_PRODUCT_DIR = DESKTOP_APP_NAME;

const PG_START_TIMEOUT_S = 60;
const PG_STOP_TIMEOUT_S = 60;
const INITDB_TIMEOUT_MS = 120_000;
const PG_CTL_MARGIN_MS = 15_000;
const START_ATTEMPTS = 3;
const MAX_SECRET_BYTES = 256;
const MAX_CAPTURE_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 4096;
const SECRET = /^[a-f0-9]{32,}$/;
const PORT_IN_USE = /address already in use|could not bind|Only one usage of each socket/i;

/** The subset of `node:path` the layout needs, so Windows paths can be built on any host. */
export type PathModule = Pick<typeof path.posix, "join" | "resolve" | "dirname" | "sep">;

export type NativePostgresFailure =
  | "root-user"
  | "binaries-missing"
  | "credentials-missing"
  | "init-failed"
  | "start-failed"
  | "stop-failed";

/** Messages carry no paths or output; `code` lets the UI pick its own wording. */
export class NativePostgresError extends Error {
  constructor(
    readonly code: NativePostgresFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "NativePostgresError";
  }
}

export interface RunProcessOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
  shell?: boolean;
  onLine?: (line: string) => void;
}

export interface RunProcessResult {
  /** Null when the process was killed by a signal or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunProcess = (
  file: string,
  args: string[],
  options: RunProcessOptions,
) => Promise<RunProcessResult>;

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

/** Fixed argv, no shell unless asked, bounded capture, killed on timeout or abort. */
export const runProcess: RunProcess = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const partial = { stdout: "", stderr: "" };
    const feed = (name: "stdout" | "stderr", chunk: string) => {
      if (name === "stdout") stdout = appendCapped(stdout, chunk);
      else stderr = appendCapped(stderr, chunk);
      if (!options.onLine) return;
      const lines = (partial[name] + chunk).split(/\r?\n/);
      partial[name] = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") options.onLine(line);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => feed("stdout", chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => feed("stderr", chunk));
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", kill, { once: true });
    if (options.signal?.aborted) kill();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      for (const name of ["stdout", "stderr"] as const) {
        if (partial[name].trim() !== "") options.onLine?.(partial[name]);
      }
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });

/** Synchronous variant for `process.on("exit")`, where nothing async can finish. */
export type RunProcessSync = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => { code: number | null };

export const runProcessSync: RunProcessSync = (file, args, options) => {
  const result = spawnSync(file, args, {
    env: options.env,
    timeout: options.timeoutMs,
    windowsHide: true,
    stdio: "ignore",
  });
  return { code: result.status };
};

/** First line of `postmaster.pid` is the server's process id. */
export function parsePostmasterPid(text: string): number | null {
  const pid = Number.parseInt(text.split(/\r?\n/, 1)[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether `pid` is still a PostgreSQL server. A reused id that now belongs to another
 * program must not be signalled by `pg_ctl`, so Linux checks the process name.
 */
export function isPostgresProcess(
  pid: number,
  input: {
    platform: string;
    kill?: (pid: number, signal: 0) => void;
    readComm?: (pid: number) => string | null;
  } = { platform: process.platform },
): boolean {
  const kill = input.kill ?? ((target, signal) => process.kill(target, signal));
  try {
    kill(pid, 0);
  } catch (error) {
    // EPERM still means the process exists.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (input.platform !== "linux") return true;
  const readComm =
    input.readComm ??
    ((target) => {
      try {
        return readFileSync(`/proc/${target}/comm`, "utf8");
      } catch {
        return null;
      }
    });
  const name = readComm(pid);
  return name === null || name.trim().startsWith("postgres");
}

/** `@embedded-postgres/<os>-<arch>` names Windows `windows`, everything else as Node does. */
export function postgresPackageName(platform: string, arch: string): string {
  return `@embedded-postgres/${platform === "win32" ? "windows" : platform}-${arch}`;
}

/** Electron's default `userData` for the product, for tools that run without Electron. */
export function defaultUserDataDir(input: {
  platform: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  path: PathModule;
}): string {
  const { platform, env, homedir } = input;
  if (platform === "win32") {
    return input.path.join(
      env.APPDATA || input.path.join(homedir, "AppData", "Roaming"),
      PG_PRODUCT_DIR,
    );
  }
  if (platform === "darwin") {
    return input.path.join(homedir, "Library", "Application Support", PG_PRODUCT_DIR);
  }
  return input.path.join(
    env.XDG_CONFIG_HOME || input.path.join(homedir, ".config"),
    PG_PRODUCT_DIR,
  );
}

export interface PostgresPaths {
  root: string;
  dataDir: string;
  scratchDir: string;
  binDir: string;
  initdb: string;
  pgCtl: string;
  postgres: string;
  ownerPasswordFile: string;
  appPasswordFile: string;
  portFile: string;
  logFile: string;
}

/** Everything the bundled server owns under `userData`, plus its three executables. */
export function postgresPaths(input: {
  userDataDir: string;
  binDir: string;
  platform: string;
  path: PathModule;
}): PostgresPaths {
  const { path: p } = input;
  const exe = input.platform === "win32" ? ".exe" : "";
  const root = p.join(input.userDataDir, PG_DIR_NAME);
  return {
    root,
    dataDir: p.join(root, PG_DATA_DIR_NAME),
    scratchDir: p.join(root, `${PG_DATA_DIR_NAME}.initializing`),
    binDir: input.binDir,
    initdb: p.join(input.binDir, `initdb${exe}`),
    pgCtl: p.join(input.binDir, `pg_ctl${exe}`),
    postgres: p.join(input.binDir, `postgres${exe}`),
    ownerPasswordFile: p.join(root, ".owner-password"),
    appPasswordFile: p.join(root, ".app-password"),
    portFile: p.join(root, "port"),
    logFile: p.join(root, "postgres.log"),
  };
}

/** Packaged builds unpack the binaries next to the archive; a path inside it cannot be executed. */
export function unpackedPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

export interface BinDirInput {
  binDir?: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  path: PathModule;
  /** Resolves a package's entry file, like `require.resolve`; throws when it is not installed. */
  resolveModule?: (name: string) => string;
}

/** Injected directory, then `RAKAZO_PG_BIN_DIR`, then the platform's embedded-postgres package. */
export function resolvePostgresBinDir(input: BinDirInput): string | null {
  const explicit = input.binDir?.trim() || input.env[PG_BIN_DIR_ENV]?.trim();
  if (explicit) return explicit;
  const resolveModule = input.resolveModule ?? createModuleRequire(import.meta.url).resolve;
  try {
    const entry = resolveModule(postgresPackageName(input.platform, input.arch));
    return unpackedPath(
      input.path.join(input.path.dirname(input.path.dirname(entry)), "native", "bin"),
    );
  } catch {
    return null;
  }
}

/** A server needs none of the app's secrets, so it only gets what it needs to start and find libraries. */
export function postgresEnv(platform: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names =
    platform === "win32"
      ? ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA"]
      : ["PATH", "HOME", "TMPDIR", "LD_LIBRARY_PATH"];
  const next: NodeJS.ProcessEnv = { LC_ALL: "C", LANG: "C" };
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) next[name] = value;
  }
  return next;
}

export function initdbArgs(input: { scratchDir: string; ownerPasswordFile: string }): string[] {
  return [
    "-D",
    input.scratchDir,
    `--username=${PG_OWNER_ROLE}`,
    `--pwfile=${input.ownerPasswordFile}`,
    "--auth=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C",
    "--no-instructions",
  ];
}

/** Loopback TCP only: no unix socket (path limits, other local users) and no other interface. */
export function startArgs(input: { dataDir: string; logFile: string; port: number }): string[] {
  const settings = [
    "-c listen_addresses=127.0.0.1",
    `-c port=${input.port}`,
    "-c unix_socket_directories=",
  ].join(" ");
  return [
    "start",
    "-D",
    input.dataDir,
    "-w",
    "-t",
    String(PG_START_TIMEOUT_S),
    "-l",
    input.logFile,
    "-o",
    settings,
  ];
}

export function stopArgs(dataDir: string): string[] {
  return ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", String(PG_STOP_TIMEOUT_S)];
}

export function databaseUrl(input: {
  role: string;
  password: string;
  port: number;
  database?: string;
}): string {
  const login = `${encodeURIComponent(input.role)}:${encodeURIComponent(input.password)}`;
  return `postgres://${login}@127.0.0.1:${input.port}/${input.database ?? PG_DATABASE}`;
}

/** Statements for single-user mode, which is how the first database and login exist without a client library. */
export function bootstrapSql(appPassword: string): string {
  if (!SECRET.test(appPassword)) throw new Error("Generated password has an unexpected shape.");
  return [
    `CREATE DATABASE ${PG_DATABASE} OWNER ${PG_OWNER_ROLE};`,
    `CREATE ROLE ${PG_APP_ROLE} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`,
    "",
  ].join("\n\n");
}

export interface PostgresEndpoints {
  port: number;
  databaseUrl: string;
  migrationUrl: string;
}

export type PostgresPhase = "stopped" | "initializing" | "starting" | "running";

export interface NativePostgresOptions {
  userDataDir: string;
  binDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  path?: PathModule;
  /** `process.getuid`; undefined on Windows. */
  getuid?: () => number | undefined;
  resolveModule?: (name: string) => string;
  exists?: (file: string) => boolean;
  run?: RunProcess;
  runSync?: RunProcessSync;
  /** Whether a process id from `postmaster.pid` still belongs to a PostgreSQL server. */
  isPostgresProcess?: (pid: number) => boolean;
  allocatePort?: () => Promise<number>;
  randomHex?: (bytes: number) => string;
}

/**
 * One bundled PostgreSQL 16 cluster under `<userData>/pg`, listening on a random loopback
 * port. The app never talks to it as a superuser: the owner login migrates, `rakazo_app`
 * (bound by row-level security) is what the API and worker use.
 */
export class NativePostgres {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: string;
  private readonly arch: string;
  private readonly pathModule: PathModule;
  private readonly run: RunProcess;
  private current: PostgresPhase = "stopped";
  private endpoints: PostgresEndpoints | null = null;
  private paths: PostgresPaths | null = null;
  private starting: Promise<PostgresEndpoints> | null = null;

  constructor(private readonly options: NativePostgresOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.pathModule = options.path ?? path;
    this.run = options.run ?? runProcess;
  }

  phase(): PostgresPhase {
    return this.current;
  }

  /** Null until the server is running. */
  running(): PostgresEndpoints | null {
    return this.current === "running" ? this.endpoints : null;
  }

  /** Idempotent: a second call joins the first, and a running server is returned as it is. */
  start(): Promise<PostgresEndpoints> {
    if (this.endpoints && this.current === "running") return Promise.resolve(this.endpoints);
    if (this.starting) return this.starting;
    const attempt = this.startServer().finally(() => {
      if (this.starting === attempt) this.starting = null;
    });
    this.starting = attempt;
    return attempt;
  }

  /** Fast shutdown (`pg_ctl stop -m fast`). A server that is not running is not an error. */
  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    let paths: PostgresPaths;
    try {
      paths = this.resolvePaths();
    } catch {
      // Nothing to stop when the binaries were never found.
      this.settle("stopped");
      return;
    }
    if (!(await this.isServerRunning(paths))) {
      this.settle("stopped");
      return;
    }
    const stopped = await this.ctl(paths, stopArgs(paths.dataDir));
    if (stopped.code !== 0 && (await this.isServerRunning(paths))) {
      throw new NativePostgresError("stop-failed", "The local database did not stop.");
    }
    this.settle("stopped");
  }

  /**
   * Last-resort shutdown for `process.on("exit")`: same fast stop, but synchronous. It does
   * nothing when no `postmaster.pid` exists, so it is cheap after a normal stop.
   */
  stopSync(): void {
    let paths: PostgresPaths;
    try {
      paths = this.resolvePaths();
    } catch {
      return;
    }
    const pidFile = this.pathModule.join(paths.dataDir, PID_FILE_NAME);
    if (!this.pidIsLive(pidFile)) return;
    (this.options.runSync ?? runProcessSync)(paths.pgCtl, stopArgs(paths.dataDir), {
      env: this.childEnv(),
      timeoutMs: PG_STOP_TIMEOUT_S * 1000,
    });
    this.settle("stopped");
  }

  private settle(phase: PostgresPhase) {
    this.current = phase;
    if (phase === "stopped") this.endpoints = null;
  }

  private resolvePaths(): PostgresPaths {
    if (this.paths) return this.paths;
    const binDir = resolvePostgresBinDir({
      binDir: this.options.binDir,
      env: this.env,
      platform: this.platform,
      arch: this.arch,
      path: this.pathModule,
      resolveModule: this.options.resolveModule,
    });
    if (binDir === null) {
      throw new NativePostgresError(
        "binaries-missing",
        "The bundled database was not found for this computer.",
      );
    }
    const paths = postgresPaths({
      userDataDir: this.options.userDataDir,
      binDir,
      platform: this.platform,
      path: this.pathModule,
    });
    const exists = this.options.exists ?? existsSync;
    if (![paths.initdb, paths.pgCtl, paths.postgres].every((file) => exists(file))) {
      throw new NativePostgresError(
        "binaries-missing",
        "The bundled database is incomplete. Reinstall the app.",
      );
    }
    this.paths = paths;
    return paths;
  }

  private refuseElevated() {
    if (this.platform === "win32") return;
    const getuid = this.options.getuid ?? process.getuid?.bind(process);
    if (getuid?.() === 0) {
      throw new NativePostgresError(
        "root-user",
        "The local database cannot run as the administrator account. Open the app as a normal user.",
      );
    }
  }

  private async startServer(): Promise<PostgresEndpoints> {
    this.refuseElevated();
    const paths = this.resolvePaths();
    try {
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      const secrets = await this.ensureSecrets(paths);
      if (!(await this.isInitialized(paths))) {
        this.current = "initializing";
        await this.initialize(paths, secrets);
      }
      this.current = "starting";
      const port = await this.startOnFreePort(paths);
      await writePrivateFile(paths.portFile, `${port}\n`);
      this.endpoints = {
        port,
        databaseUrl: databaseUrl({ role: PG_APP_ROLE, password: secrets.app, port }),
        migrationUrl: databaseUrl({ role: PG_OWNER_ROLE, password: secrets.owner, port }),
      };
      this.current = "running";
      return this.endpoints;
    } catch (error) {
      this.settle("stopped");
      throw error;
    }
  }

  private async ensureSecrets(paths: PostgresPaths): Promise<{ owner: string; app: string }> {
    const randomHex = this.options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
    const initialized = await this.isInitialized(paths);
    const read = async (file: string) => {
      const raw = (await readPrivateFile(file, MAX_SECRET_BYTES))?.trim() ?? "";
      return SECRET.test(raw) ? raw : null;
    };
    const ensure = async (file: string) => {
      const existing = await read(file);
      if (existing !== null) return existing;
      // A cluster whose passwords are gone cannot be opened, and a new password would not fit it.
      if (initialized) {
        throw new NativePostgresError(
          "credentials-missing",
          "The local database login is missing. Restore it or reset the local data.",
        );
      }
      const secret = randomHex(24);
      if (!SECRET.test(secret)) throw new Error("Secret generator returned invalid data.");
      await writePrivateFile(file, `${secret}\n`);
      return secret;
    };
    return {
      owner: await ensure(paths.ownerPasswordFile),
      app: await ensure(paths.appPasswordFile),
    };
  }

  private async isInitialized(paths: PostgresPaths): Promise<boolean> {
    return (await readPrivateFile(this.pathModule.join(paths.dataDir, "PG_VERSION"), 16)) !== null;
  }

  /**
   * Builds the cluster beside the final directory and renames it into place, so an
   * interrupted first run never leaves a half-made `data` that looks initialized.
   */
  private async initialize(paths: PostgresPaths, secrets: { owner: string; app: string }) {
    const fail = (cause?: unknown) =>
      new NativePostgresError("init-failed", "The local database could not be created.", {
        cause,
      });
    await rm(paths.scratchDir, { recursive: true, force: true });
    await rm(paths.dataDir, { recursive: true, force: true });
    const init = await this.run(
      paths.initdb,
      initdbArgs({ scratchDir: paths.scratchDir, ownerPasswordFile: paths.ownerPasswordFile }),
      { env: this.childEnv(), timeoutMs: INITDB_TIMEOUT_MS },
    );
    if (init.code !== 0) throw fail(new Error(init.stderr.slice(-LOG_TAIL_BYTES)));
    // Single-user mode skips authentication and needs no listening socket.
    const bootstrap = await this.run(
      paths.postgres,
      ["--single", "-j", "-D", paths.scratchDir, "template1"],
      { env: this.childEnv(), timeoutMs: INITDB_TIMEOUT_MS, stdin: bootstrapSql(secrets.app) },
    );
    if (bootstrap.code !== 0) throw fail(new Error(bootstrap.stderr.slice(-LOG_TAIL_BYTES)));
    await rename(paths.scratchDir, paths.dataDir);
  }

  private async startOnFreePort(paths: PostgresPaths): Promise<number> {
    const allocate = this.options.allocatePort ?? allocateLoopbackPort;
    // A server left running by a crashed session still owns the data directory.
    if (await this.isServerRunning(paths)) await this.ctl(paths, stopArgs(paths.dataDir));
    await rename(paths.logFile, `${paths.logFile}.1`).catch(() => undefined);
    let lastFailure: unknown;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      const port = await allocate();
      const started = await this.ctl(
        paths,
        startArgs({ dataDir: paths.dataDir, logFile: paths.logFile, port }),
        PG_START_TIMEOUT_S * 1000 + PG_CTL_MARGIN_MS,
      );
      if (started.code === 0) return port;
      const tail = await this.logTail(paths);
      lastFailure = new Error(`${started.stderr}\n${tail}`.slice(-LOG_TAIL_BYTES));
      // Another process took the port between allocation and bind; only that is worth retrying.
      if (!PORT_IN_USE.test(`${started.stdout}\n${started.stderr}\n${tail}`)) break;
    }
    throw new NativePostgresError("start-failed", "The local database did not start.", {
      cause: lastFailure,
    });
  }

  private async logTail(paths: PostgresPaths): Promise<string> {
    const text = await readFile(paths.logFile, "utf8").catch(() => "");
    return text.slice(-LOG_TAIL_BYTES);
  }

  private pidIsLive(pidFile: string): boolean {
    let text: string;
    try {
      text = readFileSync(pidFile, "utf8");
    } catch {
      return false;
    }
    const pid = parsePostmasterPid(text);
    if (pid === null) return false;
    return (
      this.options.isPostgresProcess ??
      ((target) => isPostgresProcess(target, { platform: this.platform }))
    )(pid);
  }

  /**
   * A killed session leaves `postmaster.pid` behind. PostgreSQL ignores one whose process
   * is gone, but not always one whose id was reused, and `pg_ctl` would then signal that
   * unrelated program. Remove the file when its process is not a PostgreSQL server.
   */
  private async clearStalePidFile(paths: PostgresPaths) {
    const pidFile = this.pathModule.join(paths.dataDir, PID_FILE_NAME);
    if (!existsSync(pidFile)) return;
    if (!this.pidIsLive(pidFile)) await rm(pidFile, { force: true });
  }

  /** `pg_ctl status` exits 0 for a running server and 3 for a stopped one. */
  private async isServerRunning(paths: PostgresPaths): Promise<boolean> {
    await this.clearStalePidFile(paths);
    const status = await this.ctl(paths, ["status", "-D", paths.dataDir]);
    return status.code === 0;
  }

  private ctl(paths: PostgresPaths, args: string[], timeoutMs = 90_000) {
    return this.run(paths.pgCtl, args, { env: this.childEnv(), timeoutMs });
  }

  private childEnv() {
    return postgresEnv(this.platform, this.env);
  }
}
