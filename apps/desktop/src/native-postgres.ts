import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { createRequire as createModuleRequire } from "node:module";
import path from "node:path";
import { allocateLoopbackPort } from "./local-stack.js";
import { createMigrationClient, type MigrationClient } from "./native-migrate.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";
import { DESKTOP_APP_NAME } from "./user-data-name.js";

export const PG_BIN_DIR_ENV = "RAKAZO_PG_BIN_DIR";
export const PG_DIR_NAME = "pg";
export const PG_DATA_DIR_NAME = "data";
const PID_FILE_NAME = "postmaster.pid";
const PG_MAJOR_VERSION = "16";
const EMPTY_VERSION_MESSAGE =
  "PG_VERSION trống hoặc không hợp lệ. Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ.";
const INCOMPLETE_DATA_DIR_MESSAGE =
  "Thư mục dữ liệu bị thiếu hoặc hỏng (không có base/ hoặc global/). Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ.";
const PG_EMPTY_DIRS = [
  "pg_notify",
  "pg_tblspc",
  "pg_twophase",
  "pg_snapshots",
  "pg_replslot",
  "pg_serial",
  "pg_commit_ts",
  "pg_dynshmem",
  "pg_stat_tmp",
  "pg_logical",
  "pg_logical/snapshots",
  "pg_logical/mappings",
] as const;
export const PG_OWNER_ROLE = "rakazo";
export const PG_APP_ROLE = "rakazo_app";
export const PG_DATABASE = "rakazo";
export const PG_PRODUCT_DIR = DESKTOP_APP_NAME;

const PG_START_TIMEOUT_S = 60;
const PG_STOP_TIMEOUT_S = 60;
const INITDB_TIMEOUT_MS = 120_000;
const PG_CTL_MARGIN_MS = 15_000;
const OUTPUT_DRAIN_MS = 500;
const KILL_GRACE_MS = 2_000;
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
  | "data-dir-unsafe"
  | "data-dir-not-owned"
  | "data-dir-symlink"
  | "data-dir-version-missing"
  | "data-dir-version-unreadable"
  | "data-dir-version-empty"
  | "data-dir-incomplete"
  | "version-mismatch"
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

export interface ClusterRepairOps {
  lstat: typeof lstat;
  chmod: typeof chmod;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
}

const clusterRepairOps: ClusterRepairOps = { lstat, chmod, mkdir, readFile };

/** Repairs only metadata and standard directories in an existing PostgreSQL 16 cluster. */
export async function repairExistingCluster(
  dataDir: string,
  input: {
    uid: number | undefined;
    path?: PathModule;
    ops?: ClusterRepairOps;
    onRepair?: (stage: string) => void;
  },
): Promise<void> {
  const ops = input.ops ?? clusterRepairOps;
  const join = input.path?.join ?? path.join;
  const data = await ops.lstat(dataDir);
  if (
    !data.isDirectory() ||
    data.isSymbolicLink() ||
    input.uid === undefined ||
    data.uid !== input.uid
  ) {
    throw new NativePostgresError(
      "data-dir-unsafe",
      "Thư mục dữ liệu không an toàn. Dữ liệu được giữ nguyên; hãy kiểm tra quyền sở hữu thư mục hoặc liên hệ hỗ trợ.",
    );
  }
  const versionFile = join(dataDir, "PG_VERSION");
  const versionStat = await ops.lstat(versionFile);
  const regularVersionFile = versionStat.isFile() && !versionStat.isSymbolicLink();
  const version = regularVersionFile ? (await ops.readFile(versionFile, "utf8")).trim() : "";
  if (regularVersionFile && version === "") {
    throw new NativePostgresError("data-dir-version-empty", EMPTY_VERSION_MESSAGE);
  }
  if (version !== PG_MAJOR_VERSION) {
    throw new NativePostgresError(
      "version-mismatch",
      "Phiên bản dữ liệu PostgreSQL không tương thích. Dữ liệu được giữ nguyên; hãy dùng phiên bản ứng dụng phù hợp hoặc khôi phục bản sao lưu.",
    );
  }
  if ((data.mode & 0o7777 & ~0o750) !== 0) {
    await ops.chmod(dataDir, 0o700);
    input.onRepair?.("postgres-repair-permissions");
  }
  for (const relative of PG_EMPTY_DIRS) {
    const directory = join(dataDir, relative);
    try {
      const existing = await ops.lstat(directory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new NativePostgresError(
          "data-dir-unsafe",
          "Thư mục dữ liệu bắt buộc không hợp lệ. Dữ liệu được giữ nguyên; hãy liên hệ hỗ trợ.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await ops.mkdir(directory, { mode: 0o700 });
      input.onRepair?.(`postgres-repair-directory:${relative}`);
    }
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
  /** No pipes to the child, for a call that leaves a long-lived server behind. */
  discardOutput?: boolean;
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

/**
 * Fixed argv, no shell unless asked, bounded capture, killed on timeout or abort.
 *
 * A server started by the child (Windows `pg_ctl start`) inherits its pipes, so `close` may
 * never fire after the child is gone. The result is settled on `exit` after a short drain, and
 * a kill that is never followed by `exit` settles too.
 */
export function createRunProcess(spawnProcess: typeof spawn = spawn): RunProcess {
  return (file, args, options) =>
    new Promise((resolve, reject) => {
      const child = spawnProcess(file, args, {
        cwd: options.cwd,
        env: options.env,
        shell: options.shell ?? false,
        windowsHide: true,
        stdio: options.discardOutput ? ["ignore", "ignore", "ignore"] : ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const timers = new Set<NodeJS.Timeout>();
      const partial = { stdout: "", stderr: "" };
      const feed = (name: "stdout" | "stderr", chunk: string) => {
        if (name === "stdout") stdout = appendCapped(stdout, chunk);
        else stderr = appendCapped(stderr, chunk);
        if (!options.onLine) return;
        const lines = (partial[name] + chunk).split(/\r?\n/);
        partial[name] = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") options.onLine(line);
      };
      const later = (ms: number, run: () => void) => {
        const timer = setTimeout(run, ms);
        timers.add(timer);
        return timer;
      };
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
        child.stdout?.destroy();
        child.stderr?.destroy();
        for (const name of ["stdout", "stderr"] as const) {
          if (partial[name].trim() !== "") options.onLine?.(partial[name]);
        }
        resolve({ code, stdout, stderr, timedOut });
      };
      function kill() {
        child.kill("SIGKILL");
        // A killed child normally reports `exit`; if it does not, the caller still gets an answer.
        later(KILL_GRACE_MS, () => finish(null));
      }
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => feed("stdout", chunk));
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => feed("stderr", chunk));
      later(options.timeoutMs, () => {
        timedOut = true;
        kill();
      });
      options.signal?.addEventListener("abort", kill, { once: true });
      if (options.signal?.aborted) kill();
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
        reject(error);
      });
      child.once("exit", (code) => later(OUTPUT_DRAIN_MS, () => finish(code)));
      child.once("close", (code) => finish(code));
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin ?? "");
    });
}

export const runProcess: RunProcess = createRunProcess();

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
 * program must not be signalled by `pg_ctl`, so Unix checks the process name.
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
  if (input.platform !== "linux" && input.platform !== "darwin") return true;
  const readComm =
    input.readComm ??
    ((target) => {
      try {
        if (input.platform === "linux") return readFileSync(`/proc/${target}/comm`, "utf8");
        const result = spawnSync("ps", ["-p", String(target), "-o", "comm="], {
          encoding: "utf8",
          timeout: 1000,
          windowsHide: true,
        });
        return result.status === 0 ? result.stdout : null;
      } catch {
        return null;
      }
    });
  const name = readComm(pid);
  return name === null || path.basename(name.trim()).startsWith("postgres");
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

/** Everything `initdb` takes besides the data directory. */
function initdbOptions(ownerPasswordFile: string): string[] {
  return [
    `--username=${PG_OWNER_ROLE}`,
    `--pwfile=${ownerPasswordFile}`,
    "--auth=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C",
    "--no-instructions",
  ];
}

export function initdbArgs(input: { scratchDir: string; ownerPasswordFile: string }): string[] {
  return ["-D", input.scratchDir, ...initdbOptions(input.ownerPasswordFile)];
}

/**
 * `pg_ctl -o` is pasted into a command line for the shell, so a path needs its own quotes.
 * Windows paths cannot contain `"`, so one means the value is not a path.
 */
function quoteForPgCtl(value: string): string {
  if (value.includes('"')) throw new Error("Value cannot be quoted for pg_ctl.");
  return `"${value}"`;
}

/**
 * Windows only: PostgreSQL refuses to run `initdb` directly from an Administrator account, but
 * `pg_ctl initdb` runs it with a restricted token. The password file is passed by path, never
 * its contents.
 */
export function pgCtlInitdbArgs(input: {
  scratchDir: string;
  ownerPasswordFile: string;
}): string[] {
  return [
    "initdb",
    "-D",
    input.scratchDir,
    "-o",
    initdbOptions(quoteForPgCtl(input.ownerPasswordFile)).join(" "),
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

function createDatabaseSql(): string {
  return `CREATE DATABASE ${PG_DATABASE} OWNER ${PG_OWNER_ROLE};`;
}

function createAppRoleSql(appPassword: string): string {
  if (!SECRET.test(appPassword)) throw new Error("Generated password has an unexpected shape.");
  return `CREATE ROLE ${PG_APP_ROLE} LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;`;
}

/** Statements for single-user mode, which is how the first database and login exist without a client library. */
export function bootstrapSql(appPassword: string): string {
  return [createDatabaseSql(), createAppRoleSql(appPassword), ""].join("\n\n");
}

/**
 * Same database and login as `bootstrapSql`, through a connected client and safe to repeat:
 * each statement runs only when its object is missing. `CREATE DATABASE` cannot share a
 * transaction, so the statements go one by one.
 */
export async function bootstrapThroughClient(
  client: Pick<MigrationClient, "query">,
  appPassword: string,
): Promise<void> {
  const exists = async (sql: string, name: string) =>
    (await client.query(sql, [name])).rows.length > 0;
  if (!(await exists("SELECT 1 FROM pg_database WHERE datname = $1", PG_DATABASE))) {
    await client.query(createDatabaseSql());
  }
  if (!(await exists("SELECT 1 FROM pg_roles WHERE rolname = $1", PG_APP_ROLE))) {
    await client.query(createAppRoleSql(appPassword));
  }
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
  /** Directory of the package that provides `pg`; Windows bootstrap connects with it. */
  dbDir?: string;
  /** Builds the client for the Windows bootstrap; defaults to the `pg` client in `dbDir`. */
  createClient?: (databaseUrl: string) => MigrationClient;
  exists?: (file: string) => boolean;
  run?: RunProcess;
  runSync?: RunProcessSync;
  /** Whether a process id from `postmaster.pid` still belongs to a PostgreSQL server. */
  isPostgresProcess?: (pid: number) => boolean;
  repairOps?: ClusterRepairOps;
  /** Filesystem probe for classifying the data directory before any startup writes. */
  dataDirOps?: Pick<ClusterRepairOps, "lstat" | "readFile"> & { readdir: typeof readdir };
  allocatePort?: () => Promise<number>;
  randomHex?: (bytes: number) => string;
  /** Progress marker for diagnostics; never carries paths or secrets. */
  onStage?: (stage: string) => void;
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
      const initialized = await this.isInitialized(paths);
      if (initialized && this.platform !== "win32") {
        await repairExistingCluster(paths.dataDir, {
          uid: (this.options.getuid ?? process.getuid?.bind(process))?.(),
          path: this.pathModule,
          ops: this.options.repairOps,
          onRepair: this.options.onStage,
        });
      }
      const secrets = await this.ensureSecrets(paths, initialized);
      if (!initialized) {
        this.current = "initializing";
        this.options.onStage?.("postgres-init");
        await this.initialize(paths, secrets);
      }
      this.current = "starting";
      this.options.onStage?.("postgres-start");
      const port = await this.startOnFreePort(paths);
      if (this.platform === "win32") await this.bootstrapAfterStart(paths, secrets, port);
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

  private async ensureSecrets(
    paths: PostgresPaths,
    initialized: boolean,
  ): Promise<{ owner: string; app: string }> {
    const randomHex = this.options.randomHex ?? ((bytes) => randomBytes(bytes).toString("hex"));
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
    const ops = this.options.dataDirOps ?? { lstat, readFile, readdir };
    let data: Awaited<ReturnType<typeof lstat>>;
    try {
      data = await ops.lstat(paths.dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new NativePostgresError(
        "data-dir-unsafe",
        "Không thể kiểm tra thư mục dữ liệu. Dữ liệu được giữ nguyên; hãy kiểm tra quyền truy cập.",
        { cause: error },
      );
    }
    if (data.isSymbolicLink()) {
      throw new NativePostgresError(
        "data-dir-symlink",
        "Thư mục dữ liệu là liên kết tượng trưng. Dữ liệu được giữ nguyên; hãy liên hệ hỗ trợ.",
      );
    }
    if (!data.isDirectory()) {
      throw new NativePostgresError(
        "data-dir-unsafe",
        "Đường dẫn dữ liệu không phải thư mục. Dữ liệu được giữ nguyên; hãy liên hệ hỗ trợ.",
      );
    }
    const uid = (this.options.getuid ?? process.getuid?.bind(process))?.();
    if (this.platform !== "win32" && (uid === undefined || data.uid !== uid)) {
      throw new NativePostgresError(
        "data-dir-not-owned",
        "Thư mục dữ liệu thuộc người dùng khác. Dữ liệu được giữ nguyên; hãy kiểm tra quyền sở hữu thư mục.",
      );
    }
    let entries: string[];
    try {
      entries = await ops.readdir(paths.dataDir);
    } catch (error) {
      throw new NativePostgresError(
        "data-dir-unsafe",
        "Không thể đọc thư mục dữ liệu. Dữ liệu được giữ nguyên; hãy kiểm tra quyền truy cập.",
        { cause: error },
      );
    }
    if (entries.length === 0) return false;
    const versionFile = this.pathModule.join(paths.dataDir, "PG_VERSION");
    let versionStat: Awaited<ReturnType<typeof lstat>>;
    try {
      versionStat = await ops.lstat(versionFile);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new NativePostgresError(
        missing ? "data-dir-version-missing" : "data-dir-version-unreadable",
        missing
          ? "Thiếu PG_VERSION trong thư mục dữ liệu. Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ."
          : "Không thể đọc PG_VERSION. Dữ liệu được giữ nguyên; hãy kiểm tra quyền thư mục và liên hệ hỗ trợ.",
        { cause: error },
      );
    }
    if (!versionStat.isFile() || versionStat.isSymbolicLink()) {
      throw new NativePostgresError(
        "data-dir-version-unreadable",
        "PG_VERSION không hợp lệ. Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ.",
      );
    }
    let version: string;
    try {
      version = (await ops.readFile(versionFile, "utf8")).trim();
    } catch (error) {
      throw new NativePostgresError(
        "data-dir-version-unreadable",
        "Không thể đọc PG_VERSION. Dữ liệu được giữ nguyên; hãy kiểm tra quyền thư mục và liên hệ hỗ trợ.",
        { cause: error },
      );
    }
    if (version === "") {
      throw new NativePostgresError("data-dir-version-empty", EMPTY_VERSION_MESSAGE);
    }
    if (version !== PG_MAJOR_VERSION) {
      throw new NativePostgresError(
        "version-mismatch",
        "Phiên bản dữ liệu PostgreSQL không tương thích. Dữ liệu được giữ nguyên; hãy dùng phiên bản ứng dụng phù hợp hoặc khôi phục bản sao lưu.",
      );
    }
    for (const name of ["base", "global"]) {
      let directory: Awaited<ReturnType<typeof lstat>>;
      try {
        directory = await ops.lstat(this.pathModule.join(paths.dataDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new NativePostgresError("data-dir-incomplete", INCOMPLETE_DATA_DIR_MESSAGE);
      }
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new NativePostgresError("data-dir-incomplete", INCOMPLETE_DATA_DIR_MESSAGE);
      }
    }
    return true;
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
    const initInput = {
      scratchDir: paths.scratchDir,
      ownerPasswordFile: paths.ownerPasswordFile,
    };
    let initFile: string;
    let initArgs: string[];
    try {
      [initFile, initArgs] =
        this.platform === "win32"
          ? [paths.pgCtl, pgCtlInitdbArgs(initInput)]
          : [paths.initdb, initdbArgs(initInput)];
    } catch (error) {
      throw fail(error);
    }
    const init = await this.run(initFile, initArgs, {
      env: this.childEnv(),
      timeoutMs: INITDB_TIMEOUT_MS,
    });
    if (init.code !== 0) throw fail(new Error(init.stderr.slice(-LOG_TAIL_BYTES)));
    if (this.platform === "win32") {
      // `postgres --single` refuses an Administrator account; the database and login are
      // created through a client once the server is up (`bootstrapAfterStart`).
      await this.installInitializedCluster(paths);
      return;
    }
    // Single-user mode skips authentication and needs no listening socket.
    const bootstrap = await this.run(
      paths.postgres,
      ["--single", "-j", "-D", paths.scratchDir, "template1"],
      { env: this.childEnv(), timeoutMs: INITDB_TIMEOUT_MS, stdin: bootstrapSql(secrets.app) },
    );
    if (bootstrap.code !== 0) throw fail(new Error(bootstrap.stderr.slice(-LOG_TAIL_BYTES)));
    await this.installInitializedCluster(paths);
  }

  private async installInitializedCluster(paths: PostgresPaths): Promise<void> {
    // rmdir succeeds only for an empty directory; existing content is never removed.
    try {
      await rmdir(paths.dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(paths.scratchDir, paths.dataDir);
  }

  /**
   * Windows only. Runs on every start because it is cheap and repeatable, which also finishes
   * a first run that was interrupted after `initdb`. A failure stops the server again.
   */
  private async bootstrapAfterStart(
    paths: PostgresPaths,
    secrets: { owner: string; app: string },
    port: number,
  ) {
    const dbDir = this.options.dbDir;
    const createClient =
      this.options.createClient ??
      (dbDir === undefined ? undefined : (url: string) => createMigrationClient(url, dbDir));
    let failure: unknown;
    if (createClient === undefined) {
      failure = new Error("No database client is available for the first-run setup.");
    } else {
      try {
        const client = createClient(
          databaseUrl({
            role: PG_OWNER_ROLE,
            password: secrets.owner,
            port,
            database: "postgres",
          }),
        );
        try {
          await client.connect();
          await bootstrapThroughClient(client, secrets.app);
        } finally {
          await client.end().catch(() => undefined);
        }
      } catch (error) {
        // The driver's message never holds a password; the cause is kept without its stack.
        failure = new Error(error instanceof Error ? error.message : "bootstrap failed");
      }
    }
    if (failure === undefined) return;
    await this.ctl(paths, stopArgs(paths.dataDir)).catch(() => undefined);
    throw new NativePostgresError("init-failed", "The local database could not be created.", {
      cause: failure,
    });
  }

  private async startOnFreePort(paths: PostgresPaths): Promise<number> {
    const allocate = this.options.allocatePort ?? allocateLoopbackPort;
    // A server left running by a crashed session still owns the data directory.
    if (await this.isServerRunning(paths)) await this.ctl(paths, stopArgs(paths.dataDir));
    await rename(paths.logFile, `${paths.logFile}.1`).catch(() => undefined);
    let lastFailure: unknown;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      const port = await allocate();
      // On Windows the server inherits the child's handles; its output is in the `-l` file anyway.
      const started = await this.ctl(
        paths,
        startArgs({ dataDir: paths.dataDir, logFile: paths.logFile, port }),
        PG_START_TIMEOUT_S * 1000 + PG_CTL_MARGIN_MS,
        this.platform === "win32",
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
   * unrelated program. Remove it only when its PID is dead or belongs to a non-Postgres
   * process (Linux: /proc/<pid>/comm; macOS: ps -o comm=). Keep a live Postgres PID.
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

  private ctl(paths: PostgresPaths, args: string[], timeoutMs = 90_000, discardOutput = false) {
    return this.run(paths.pgCtl, args, {
      env: this.childEnv(),
      timeoutMs,
      ...(discardOutput ? { discardOutput } : {}),
    });
  }

  private childEnv() {
    return postgresEnv(this.platform, this.env);
  }
}
