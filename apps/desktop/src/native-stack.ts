import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { managedLoopbackHost } from "@rakazo/adapters/host-computer-server";
import type {
  IdentityExchangeConfig,
  NativeIssuerPin,
} from "@rakazo/auth/identity-exchange-config";
import {
  parseIdentityExchangeConfig,
  parseNativeIssuerPin,
} from "@rakazo/auth/identity-exchange-config";
import { createRemoteDeviceKey } from "@rakazo/auth/remote-device-key";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import {
  nativeBundleFiles as contractBundleFiles,
  nativeBundleManifest as contractBundleManifest,
  isNativePostgresVersion,
} from "../scripts/native-bundle-contract.mjs";
import { snapshotLegacyProfile } from "./legacy-profile-snapshot.js";
import type { LegacyNativeSecrets, LegacyUpgradeReceipt } from "./legacy-upgrade.js";
import {
  copyLegacyFiles,
  LEGACY_CLUSTER,
  LEGACY_NATIVE_ENTRIES,
  legacyFileSources,
  planLegacyUpgrade,
  readLegacyNativeSecrets,
  readLegacyUpgradeReceipt,
  writeLegacyUpgradeReceipt,
} from "./legacy-upgrade.js";
import { allocateLoopbackPort } from "./local-stack.js";
import {
  CURRENT_NATIVE_DIRECTORY,
  CURRENT_NATIVE_LAYOUT_ID,
  CURRENT_NATIVE_POSTGRES_MAJOR,
  LEGACY_PROFILE_MARKERS,
} from "./native-postgres-layout.js";
import { createNativeProcess } from "./native-process.js";
import { NativeRuntime } from "./native-runtime.js";
import { smokeLog } from "./native-smoke.js";
import { nativeWeb } from "./native-web.js";
import { postgresReady } from "./postgres-ready.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";
import { ensureWindowsLinks } from "./windows-links.js";

const SECRET_KEYS = ["owner", "runtime", "auth", "encryption", "token", "screen"] as const;
const NODE_NAME = process.platform === "win32" ? "node.exe" : "node";
const GENERIC_FAILURE =
  "Native runtime unavailable. A complete reviewed native bundle is required.";
const SAFE_MESSAGES = new Set([
  "Existing native data requires a verified copy-only migration before startup.",
  "Native identity setup is required.",
  "Unrecognized native data directory.",
  "Invalid native credentials.",
  "Native credentials are missing.",
  "Invalid native database directory.",
  "Native database version mismatch.",
  "Interrupted database initialization requires inspection.",
  "Invalid native origin.",
  "Native bundle must provide PostgreSQL 18.",
  "Native bundle target mismatch.",
  "Incomplete native bundle.",
  "Invalid native bundle asset.",
  "Native Node target mismatch.",
  "Invalid identity exchange configuration",
  "Identity exchange rejected",
]);

export type NativeSecrets = Record<(typeof SECRET_KEYS)[number], string>;

/**
 * Electron copies `build/native` to `resources/native`. electron-builder drops a
 * `node_modules` at the root of a copied folder, so the copy starts one level up.
 */
export const NATIVE_BUNDLE_RESOURCE = { from: "build", to: ".", filter: ["native/**/*"] };

export function nativeBundleFiles(platform: NodeJS.Platform = process.platform): string[] {
  return contractBundleFiles(platform);
}

/** The manifest `validateNativeBundle` accepts. Postgres major 18 is the only current target. */
export function nativeBundleManifest(input: { platform: NodeJS.Platform; arch: string }) {
  return contractBundleManifest(input);
}

/** Packaged installs never fall back to Docker. Development keeps Docker until a bundle exists. */
export function selectDesktopStack(input: {
  packaged: boolean;
  nativeBundlePresent: boolean;
}): "native" | "docker" {
  if (input.packaged) return "native";
  return input.nativeBundlePresent ? "native" : "docker";
}

export function nativeBundleDirectory(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return input.packaged
    ? path.join(input.resourcesPath, "native")
    : path.join(input.appPath, "build", "native");
}

/**
 * Credentials the API and worker may use to reach this machine's host computer.
 * A Docker gateway URL or an inherited process value is not a native connection.
 */
export function nativeHostComputerEnv(hostComputer: { url: string; token: string } | undefined): {
  SANDBOX_PROVIDER: "none";
  SANDBOX_HOST_URL: string;
  SANDBOX_HOST_TOKEN: string;
} {
  const managed = loopbackHostComputer(hostComputer);
  return {
    SANDBOX_PROVIDER: "none",
    SANDBOX_HOST_URL: managed?.url ?? "",
    SANDBOX_HOST_TOKEN: managed?.token ?? "",
  };
}

function loopbackHostComputer(
  hostComputer: { url: string; token: string } | undefined,
): { url: string; token: string } | undefined {
  return managedLoopbackHost(hostComputer);
}

/** Native children receive no ambient database, provider, credential or Node injection settings. */
export function nativeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", RAKAZO_LOAD_ROOT_ENV: "false" };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Never initialize over an old profile, even when its major happens to match. */
export async function assertNativeProfileSafe(profile: string) {
  for (const name of LEGACY_PROFILE_MARKERS) {
    if (await exists(path.join(profile, name))) {
      throw new Error(
        "Existing native data requires a verified copy-only migration before startup.",
      );
    }
  }
}

const DEVICE_FILE = "native-device.json";

export async function readNativeDeviceConfig(
  profile: string,
): Promise<Extract<IdentityExchangeConfig, { kind: "local" }>> {
  const raw = await readPrivateFile(path.join(profile, DEVICE_FILE), 16_384);
  const config = parseIdentityExchangeConfig(raw ?? undefined);
  if (config?.kind !== "local") throw new Error("Native identity setup is required.");
  return config;
}

function samePin(config: Extract<IdentityExchangeConfig, { kind: "local" }>, pin: NativeIssuerPin) {
  return (
    config.issuer === pin.issuer &&
    config.audience === pin.audience &&
    config.publicKey === pin.publicKey &&
    config.centralAuthUrl === pin.centralAuthUrl &&
    config.centralOrigin === pin.centralOrigin
  );
}

/** Writes one stable device binding. A different pin or an unreadable file is left untouched. */
export async function ensureNativeDeviceFile(profile: string, pin: NativeIssuerPin) {
  const file = path.join(profile, DEVICE_FILE);
  const raw = await readPrivateFile(file, 16_384);
  if (raw !== null) {
    const config = parseIdentityExchangeConfig(raw);
    if (config?.kind !== "local" || !samePin(config, pin)) {
      throw new Error("Native identity setup is required.");
    }
    if (config.devicePrivateKey) return config;
    const upgraded = parseIdentityExchangeConfig(
      JSON.stringify({ ...config, devicePrivateKey: createRemoteDeviceKey().privateKey }),
    );
    if (upgraded?.kind !== "local" || upgraded.deviceId !== config.deviceId) {
      throw new Error("Native identity setup is required.");
    }
    await writePrivateFile(file, JSON.stringify(upgraded));
    return upgraded;
  }
  if (await exists(file)) throw new Error("Native identity setup is required.");
  const created = parseIdentityExchangeConfig(
    JSON.stringify({
      kind: "local",
      ...pin,
      deviceId: randomBytes(32).toString("hex"),
      devicePrivateKey: createRemoteDeviceKey().privateKey,
    }),
  );
  if (created?.kind !== "local") throw new Error("Native identity setup is required.");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writePrivateFile(file, JSON.stringify(created));
  return created;
}

function parseSecrets(raw: string): NativeSecrets {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid native credentials.");
  const secrets = {} as NativeSecrets;
  for (const key of SECRET_KEYS) {
    const value: unknown = Reflect.get(parsed, key);
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error("Invalid native credentials.");
    }
    secrets[key] = value;
  }
  return secrets;
}

/**
 * Creates the current layout only. An upgrade passes the keys its copied rows were
 * written with; a layout saved with other keys is never reused for that copy.
 */
export async function prepareCurrentNativeLayout(
  profile: string,
  kept?: Pick<NativeSecrets, "auth" | "encryption">,
): Promise<{
  root: string;
  dataDir: string;
  webPort: number;
  secrets: NativeSecrets;
  needsInit: boolean;
}> {
  const root = path.join(profile, CURRENT_NATIVE_DIRECTORY);
  const layoutFile = path.join(root, "layout");
  if (!(await exists(root))) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writePrivateFile(layoutFile, CURRENT_NATIVE_LAYOUT_ID);
  } else if (
    (await lstat(root)).isSymbolicLink() ||
    (await readPrivateFile(layoutFile, 128)) !== CURRENT_NATIVE_LAYOUT_ID
  ) {
    throw new Error("Unrecognized native data directory.");
  }
  const secretFile = path.join(root, "credentials.json");
  const dataDir = path.join(root, "data");
  const saved = await readPrivateFile(secretFile, 4096);
  let secrets: NativeSecrets;
  if (saved !== null) secrets = parseSecrets(saved);
  else if (await exists(dataDir)) throw new Error("Native credentials are missing.");
  else {
    secrets = {
      ...(Object.fromEntries(
        SECRET_KEYS.map((key) => [key, randomBytes(32).toString("hex")]),
      ) as NativeSecrets),
      ...(kept && { auth: kept.auth, encryption: kept.encryption }),
    };
    await writePrivateFile(secretFile, JSON.stringify(secrets));
  }
  if (kept && (secrets.auth !== kept.auth || secrets.encryption !== kept.encryption)) {
    throw new Error("Unrecognized native data directory.");
  }
  const scratch = path.join(root, "data.initializing");
  if (await exists(dataDir)) {
    if ((await lstat(dataDir)).isSymbolicLink()) {
      throw new Error("Invalid native database directory.");
    }
    if (
      (await readFile(path.join(dataDir, "PG_VERSION"), "utf8")).trim() !==
      CURRENT_NATIVE_POSTGRES_MAJOR
    ) {
      throw new Error("Native database version mismatch.");
    }
  } else if (await exists(scratch)) {
    throw new Error("Interrupted database initialization requires inspection.");
  }
  const portFile = path.join(root, "web-port");
  const savedPort = await readPrivateFile(portFile, 16);
  const webPort = savedPort === null ? await allocateLoopbackPort() : Number(savedPort);
  if (!Number.isInteger(webPort) || webPort < 1024 || webPort > 65535) {
    throw new Error("Invalid native origin.");
  }
  if (savedPort === null) await writePrivateFile(portFile, String(webPort));
  return { root, dataDir, webPort, secrets, needsInit: !(await exists(dataDir)) };
}

function run(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeout = 120_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, env, signal, timeout, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(new Error("Native command failed."));
        else resolve(stdout.trim());
      },
    );
  });
}

async function poll(signal: AbortSignal, check: () => Promise<boolean>) {
  while (!signal.aborted) {
    if (await check().catch(() => false)) return;
    await setTimeout(100, undefined, { signal });
  }
  signal.throwIfAborted();
}

export function assertNativeBundleManifest(
  manifest: unknown,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  const files: unknown =
    manifest && typeof manifest === "object" ? Reflect.get(manifest, "files") : undefined;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Reflect.get(manifest, "version") !== 1 ||
    Reflect.get(manifest, "platform") !== platform ||
    // One macOS bundle can serve both chips; its node and servers are universal.
    (Reflect.get(manifest, "arch") !== arch &&
      !(platform === "darwin" && Reflect.get(manifest, "arch") === "universal")) ||
    Reflect.get(manifest, "postgresMajor") !== 18 ||
    !files ||
    typeof files !== "object"
  ) {
    throw new Error("Native bundle target mismatch.");
  }
  for (const file of nativeBundleFiles(platform)) {
    if (Reflect.get(files, file) !== true) throw new Error("Incomplete native bundle.");
  }
  return files as Record<string, unknown>;
}

/** Rejects a path that resolves outside the bundle, including a symlink to another tree. */
export async function assertNativeBundleTree(root: string, files: Record<string, unknown>) {
  for (const file of Object.keys(files)) {
    const resolved = await realpath(path.resolve(root, file));
    if (!resolved.startsWith(`${root}${path.sep}`) || !(await stat(resolved)).isFile()) {
      throw new Error("Invalid native bundle asset.");
    }
  }
  for (const directory of ["pg/lib", "packages/db/prisma/migrations"]) {
    const resolved = await realpath(path.join(root, directory));
    if (
      !resolved.startsWith(`${root}${path.sep}`) ||
      !(await stat(resolved)).isDirectory() ||
      (await readdir(resolved)).length === 0
    ) {
      throw new Error("Invalid native bundle asset.");
    }
  }
  const migrations = path.join(root, "packages/db/prisma/migrations");
  let hasMigration = false;
  for (const entry of await readdir(migrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(migrations, entry.name, "migration.sql");
    if (!(await exists(file))) continue;
    const resolved = await realpath(file);
    if (!resolved.startsWith(`${root}${path.sep}`) || !(await stat(resolved)).isFile()) {
      throw new Error("Invalid native bundle asset.");
    }
    hasMigration = true;
  }
  if (!hasMigration) throw new Error("Invalid native bundle asset.");
}

export async function validateNativeBundle(
  bundle: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const root = await realpath(bundle);
  const manifest: unknown = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const files = assertNativeBundleManifest(manifest);
  await assertNativeBundleTree(root, files);
  await ensureWindowsLinks(root);
  const target = await run(
    path.join(root, NODE_NAME),
    ["-p", "process.platform + '/' + process.arch"],
    root,
    nativeEnvironment(env),
    signal,
  );
  if (target !== `${process.platform}/${process.arch}`) {
    throw new Error("Native Node target mismatch.");
  }
}

function childEnvironment(source: NodeJS.ProcessEnv, bundle: string, home: string) {
  const env = nativeEnvironment(source);
  const lib = path.join(bundle, "pg", "lib");
  env.HOME = home;
  env.USERPROFILE = home;
  env.LD_LIBRARY_PATH = lib;
  const pathName = process.platform === "win32" ? "Path" : "PATH";
  const current = env[pathName] ?? env.PATH;
  env[pathName] = current ? `${lib}${path.delimiter}${current}` : lib;
  return env;
}

/**
 * Starts the bundled PostgreSQL 16 on the stopped copy, never on the original, and
 * imports it into the current database. A failure keeps the copy for the next launch.
 */
async function importLegacyProfile(input: {
  bundle: string;
  root: string;
  snapshot: string;
  legacy: LegacyNativeSecrets;
  receipt: LegacyUpgradeReceipt;
  /** Migration environment of the current stack. */
  env: NodeJS.ProcessEnv;
  /** PostgreSQL 18 child environment. */
  base: NodeJS.ProcessEnv;
  signal: AbortSignal;
}) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const pathName = process.platform === "win32" ? "Path" : "PATH";
  const bin = path.join(input.bundle, "pg16", "bin");
  const lib = path.join(input.bundle, "pg16", "lib");
  const readerEnv = {
    ...input.base,
    LD_LIBRARY_PATH: lib,
    DYLD_LIBRARY_PATH: lib,
    [pathName]: [bin, input.base[pathName]].filter(Boolean).join(path.delimiter),
  };
  const port = String(await allocateLoopbackPort());
  const reader = createNativeProcess({
    executable: path.join(bin, `postgres${exe}`),
    args: [
      "-D",
      path.join(input.snapshot, "pg", "data"),
      "-h",
      "127.0.0.1",
      "-p",
      port,
      "-c",
      "unix_socket_directories=",
    ],
    cwd: input.root,
    env: readerEnv,
    // A copy of a profile that was not shut down cleanly replays its log first.
    startupTimeoutMs: 10 * 60_000,
    stopTimeoutMs: 60_000,
    ready: (readySignal) => poll(readySignal, () => postgresReady(Number(port), readySignal)),
  });
  const source = new URL(`postgresql://127.0.0.1:${port}/${LEGACY_CLUSTER.database}`);
  source.username = LEGACY_CLUSTER.ownerRole;
  source.password = input.legacy.owner;
  await reader.start(input.signal);
  try {
    await run(
      path.join(input.bundle, NODE_NAME),
      [path.join(input.bundle, "apps", "api", "dist", "cli", "import-legacy-native.js")],
      input.bundle,
      {
        ...input.env,
        LEGACY_DATABASE_URL: source.toString(),
        LEGACY_SOURCE_DIGEST: input.receipt.sourceDigest,
        LEGACY_BASELINE_DIR: path.join(input.root, "legacy-baseline"),
      },
      input.signal,
      30 * 60_000,
    );
  } finally {
    await reader.stop();
  }
  await copyLegacyFiles(
    await legacyFileSources([
      path.join(input.snapshot, "data"),
      path.join(process.cwd(), "data"),
      path.join(homedir(), "data"),
    ]),
    path.join(input.root, "files"),
  );
  await writeLegacyUpgradeReceipt(input.root, { ...input.receipt, phase: "verified" });
  // The original 0.3.9 data is the rollback copy; this working copy is no longer needed.
  await rm(input.snapshot, { recursive: true, force: true }).catch(() => undefined);
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  // A packaged smoke run records the cause; the window still shows the generic text.
  smokeLog(`RAKAZO_DESKTOP_SMOKE cause=${message}`);
  return SAFE_MESSAGES.has(message) ? message : GENERIC_FAILURE;
}

export class NativeStackController {
  private runtime: NativeRuntime | undefined;
  private pending: Promise<DesktopLocalStackState> | undefined;
  private cancellation: AbortController | undefined;
  private url = "http://127.0.0.1:8080";
  private current: DesktopLocalStackState = {
    phase: "idle",
    message: null,
    output: [],
    layerBytes: {},
    imageTag: "native",
  };
  private token: string | null = null;
  private workerHealth: string | undefined;

  constructor(
    private readonly input: {
      profile: string;
      /** Reviewed native distribution containing node, PostgreSQL 18, API, worker and web. */
      bundle: string;
      env: NodeJS.ProcessEnv;
      /** Public issuer pin. Absent pin keeps an existing device file and never invents an issuer. */
      issuerPin?: string;
      /** Loopback host-computer connection. Absent or non-loopback stays closed. */
      hostComputer?: { url: string; token: string };
      onState(state: DesktopLocalStackState): void;
    },
  ) {}

  state() {
    return this.current;
  }

  webUrl() {
    return this.url;
  }

  stackToken() {
    return this.token;
  }

  private update(phase: DesktopLocalStackState["phase"], message: string | null = null) {
    this.current = { ...this.current, phase, message };
    this.input.onState(this.current);
  }

  async matchesDesiredStack(url = this.url) {
    if (
      url !== this.url ||
      this.runtime?.status() !== "ready" ||
      !this.token ||
      !this.workerHealth
    ) {
      return false;
    }
    try {
      const response = await fetch(`${url}/.well-known/rakazo-desktop-stack`, {
        headers: { "x-rakazo-desktop-stack-token": this.token },
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return false;
      const health: unknown = JSON.parse(await readFile(this.workerHealth, "utf8"));
      if (
        !health ||
        typeof health !== "object" ||
        !("heartbeat" in health) ||
        typeof health.heartbeat !== "number" ||
        Date.now() - health.heartbeat > 90_000
      ) {
        return false;
      }
      return (
        await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" })
      ).ok;
    } catch {
      return false;
    }
  }

  start(): Promise<DesktopLocalStackState> {
    if (this.pending) return this.pending;
    const controller = new AbortController();
    this.cancellation = controller;
    const pending = this.boot(controller.signal)
      .catch(async (error: unknown) => {
        await this.runtime?.stop().catch(() => undefined);
        this.update(
          controller.signal.aborted ? "idle" : "failed",
          controller.signal.aborted ? null : safeMessage(error),
        );
        return this.current;
      })
      .finally(() => {
        this.pending = undefined;
        this.cancellation = undefined;
      });
    this.pending = pending;
    return pending;
  }

  abort() {
    this.cancellation?.abort();
  }

  async stop() {
    this.abort();
    await this.pending;
    await this.runtime?.stop();
    this.update("idle");
    return this.current;
  }

  private async boot(signal: AbortSignal) {
    if (await this.matchesDesiredStack()) return this.current;
    await this.runtime?.stop();
    this.update("preparing");
    const currentRoot = path.join(this.input.profile, CURRENT_NATIVE_DIRECTORY);
    let receipt = await readLegacyUpgradeReceipt(currentRoot);
    // After a verified upgrade the 0.3.9 data stays untouched as the rollback copy.
    let legacy: LegacyNativeSecrets | undefined;
    if (receipt?.phase !== "verified") {
      const upgrade = await planLegacyUpgrade({ profile: this.input.profile });
      switch (upgrade.action) {
        case "blocked":
          throw new Error(
            "Existing native data requires a verified copy-only migration before startup.",
          );
        case "fresh":
          if (receipt) throw new Error("Unrecognized native data directory.");
          await assertNativeProfileSafe(this.input.profile);
          break;
        case "copy":
          legacy = await readLegacyNativeSecrets(this.input.profile);
          break;
        default: {
          const unreachable: never = upgrade;
          throw new Error(unreachable);
        }
      }
    }
    const pin = parseNativeIssuerPin(this.input.issuerPin);
    const identity = pin
      ? await ensureNativeDeviceFile(this.input.profile, pin)
      : await readNativeDeviceConfig(this.input.profile);
    await validateNativeBundle(this.input.bundle, this.input.env, signal);
    const bundle = await realpath(this.input.bundle);
    const executable = (name: string) =>
      path.join(bundle, "pg", "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
    for (const file of [path.join(bundle, "pg", "lib"), path.join(bundle, "pg", "share")]) {
      await access(file);
    }
    signal.throwIfAborted();
    const probed = childEnvironment(this.input.env, bundle, this.input.profile);
    const version = await run(executable("postgres"), ["--version"], bundle, probed, signal);
    if (!isNativePostgresVersion(version)) {
      throw new Error("Native bundle must provide PostgreSQL 18.");
    }
    const prepared = await prepareCurrentNativeLayout(this.input.profile, legacy);
    const snapshot = path.join(prepared.root, "legacy-snapshot");
    if (legacy && !receipt) {
      const copied = await snapshotLegacyProfile({
        profile: this.input.profile,
        entries: LEGACY_NATIVE_ENTRIES,
        destination: snapshot,
      });
      receipt = { version: 1, phase: "importing", sourceDigest: copied.sourceDigest };
      await writeLegacyUpgradeReceipt(prepared.root, receipt);
    }
    const base = childEnvironment(this.input.env, bundle, prepared.root);
    if (prepared.needsInit) {
      const scratch = path.join(prepared.root, "data.initializing");
      const password = path.join(prepared.root, "owner-password");
      await writePrivateFile(password, prepared.secrets.owner);
      await run(
        executable("initdb"),
        [
          "-D",
          scratch,
          "--username=postgres",
          "-L",
          path.join(bundle, "pg", "share"),
          `--pwfile=${password}`,
          "--auth=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
        ],
        prepared.root,
        base,
        signal,
      );
      await rename(scratch, prepared.dataDir);
    }
    const pgPort = await allocateLoopbackPort();
    const apiPort = await allocateLoopbackPort();
    this.url = `http://127.0.0.1:${prepared.webPort}`;
    this.token = prepared.secrets.token;
    const database = (role: string, password: string) =>
      `postgresql://${role}:${password}@127.0.0.1:${pgPort}/postgres`;
    const health = path.join(prepared.root, "worker-health.json");
    this.workerHealth = health;
    const node = path.join(bundle, NODE_NAME);
    const env = {
      ...base,
      RAKAZO_IDENTITY_EXCHANGE: JSON.stringify(identity),
      RAKAZO_DB_PACKAGE_DIR: path.join(bundle, "packages", "db"),
      DATABASE_URL: database("rakazo_app", prepared.secrets.runtime),
      API_HOST: "127.0.0.1",
      API_PORT: String(apiPort),
      WEB_ORIGIN: this.url,
      BETTER_AUTH_URL: this.url,
      BETTER_AUTH_SECRET: prepared.secrets.auth,
      ENCRYPTION_KEY: prepared.secrets.encryption,
      SCREEN_PROXY_SECRET: prepared.secrets.screen,
      RAKAZO_DESKTOP_STACK_TOKEN: prepared.secrets.token,
      RAKAZO_IMAGE_TAG: "native",
      DATA_DIR: path.join(prepared.root, "files"),
      WORKER_HEALTH_FILE: health,
      SANDBOX_PROVIDER: "none",
      SANDBOX_HOST_URL: "",
      SANDBOX_HOST_TOKEN: "",
    };
    const serviceEnv = { ...env, ...nativeHostComputerEnv(this.input.hostComputer) };
    const service = (entry: string, ready: (readySignal: AbortSignal) => Promise<void>) =>
      createNativeProcess({
        executable: node,
        args: [path.join(bundle, entry)],
        cwd: prepared.root,
        env: serviceEnv,
        ready,
      });
    const api = service("apps/api/dist/index.js", (readySignal) =>
      poll(
        readySignal,
        async () =>
          (
            await fetch(`http://127.0.0.1:${apiPort}/health`, {
              signal: readySignal,
              redirect: "error",
            })
          ).ok,
      ),
    );
    const web = nativeWeb({
      port: prepared.webPort,
      apiPort,
      web: path.join(bundle, "apps", "web", "dist"),
      token: prepared.secrets.token,
    });
    let bootTime = 0;
    this.runtime = new NativeRuntime({
      origin: this.url,
      postgres: createNativeProcess({
        executable: executable("postgres"),
        args: [
          "-D",
          prepared.dataDir,
          "-h",
          "127.0.0.1",
          "-p",
          String(pgPort),
          "-c",
          "unix_socket_directories=",
          "-c",
          `dynamic_library_path=${path.join(bundle, "pg", "lib")}`,
        ],
        cwd: prepared.root,
        env: base,
        ready: (readySignal) => poll(readySignal, () => postgresReady(pgPort, readySignal)),
      }),
      migrate: async (readySignal) => {
        const migrationEnv = {
          ...env,
          DATABASE_MIGRATION_URL: database("postgres", prepared.secrets.owner),
        };
        if (legacy && receipt?.phase === "importing") {
          await importLegacyProfile({
            bundle,
            root: prepared.root,
            snapshot,
            legacy,
            receipt,
            env: migrationEnv,
            base,
            signal: readySignal,
          });
        }
        await run(
          node,
          [path.join(bundle, "apps", "api", "dist", "cli", "migrate-database.js")],
          bundle,
          migrationEnv,
          readySignal,
        );
      },
      api: {
        async start(readySignal) {
          await api.start(readySignal);
          await web.start(readySignal);
        },
        async stop() {
          await web.stop();
          await api.stop();
        },
      },
      worker: service("apps/worker/dist/index.js", (readySignal) =>
        poll(readySignal, async () => {
          const value: unknown = JSON.parse(await readFile(health, "utf8"));
          return (
            !!value &&
            typeof value === "object" &&
            "heartbeat" in value &&
            typeof value.heartbeat === "number" &&
            value.heartbeat > bootTime
          );
        }),
      ),
    });
    bootTime = Date.now();
    this.update("starting");
    signal.throwIfAborted();
    const runtime = this.runtime;
    const cancel = () => {
      void runtime.stop().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await runtime.start();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
    signal.throwIfAborted();
    this.update("ready");
    return this.current;
  }
}
