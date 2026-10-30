import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { utilityProcess } from "electron";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export interface UtilityChild {
  once(event: string, listener: (...args: unknown[]) => void): this;
  kill(): void;
}
export type UtilityFork = (entry: string, args: string[], options: { env: NodeJS.ProcessEnv }) => UtilityChild;

export interface NativeServicesDeps {
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  userDataDir: string;
  packaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  pathModule?: typeof path;
  fork?: UtilityFork;
  fetch?: typeof fetch;
  allocatePort?: () => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  maxRestarts?: number;
  webDir?: string;
  serveWeb?: boolean;
}

export interface NativeServices {
  start(env?: Record<string, string>): Promise<{ webUrl: string }>;
  stop(): Promise<void>;
}

const SECRET_BYTES: Record<string, number> = {
  POSTGRES_PASSWORD: 16,
  POSTGRES_APP_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
};
const ENV_FILE = "native-stack-env";

function randomHex(bytes: number) { return randomBytes(bytes).toString("hex"); }

async function loadEnv(userDataDir: string, supplied: Record<string, string>, base: NodeJS.ProcessEnv) {
  await mkdir(userDataDir, { recursive: true });
  const file = path.join(userDataDir, ENV_FILE);
  let values: Record<string, string> = {};
  const raw = await readPrivateFile(file, 64 * 1024);
  if (raw) {
    try { values = JSON.parse(raw) as Record<string, string>; } catch { values = {}; }
  }
  for (const [name, bytes] of Object.entries(SECRET_BYTES)) values[name] ??= randomHex(bytes);
  values = { ...values, ...supplied };
  await writePrivateFile(file, JSON.stringify(values));
  return { ...base, ...values };
}

export function resolveNativeEntryPath(input: Pick<NativeServicesDeps, "packaged" | "resourcesPath" | "appPath" | "pathModule">, packageName: "api" | "worker" | "migrate") {
  const p = input.pathModule ?? path;
  const root = input.packaged
    ? p.join(input.resourcesPath ?? "", "server")
    : p.resolve(input.appPath ?? process.cwd(), "..", "..", "apps");
  if (packageName === "migrate") return p.join(root, "api", "dist", "cli", "migrate-database.js");
  return p.join(root, packageName, "dist", "index.js");
}

/** Stable per-user location for the native API port, including Windows profiles. */
export function nativePortFilePath(userDataDir: string, pathModule: typeof path = path) {
  return pathModule.join(userDataDir, "native-api-port");
}

function defaultPort() { return new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
  });
}); }

export function createNativeServices(input: NativeServicesDeps): NativeServices {
  const envBase = input.env ?? process.env;
  const fork: UtilityFork = input.fork ?? ((entry, args, options) => utilityProcess.fork(entry, args, options) as unknown as UtilityChild);
  const fetchImpl = input.fetch ?? fetch;
  const allocatePort = input.allocatePort ?? defaultPort;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const children: UtilityChild[] = [];
  let webServer: Server | undefined;
  let started = false;

  async function start(extra: Record<string, string> = {}) {
    if (started) return { webUrl: currentUrl! };
    const env = await loadEnv(input.userDataDir, extra, envBase);
    const apiPort = await allocatePort();
    const workerPort = await allocatePort();
    const runtimeEnv = { ...env, DATABASE_URL: env.DATABASE_URL ?? `postgresql://127.0.0.1:${env.POSTGRES_PORT ?? "5432"}/rakazo`, API_PORT: String(apiPort), WORKER_PORT: String(workerPort), API_HOST: "127.0.0.1", SANDBOX_PROVIDER: "desktop" };
    const migrate = fork(resolveNativeEntryPath(input, "migrate"), [], { env: runtimeEnv });
    children.push(migrate);
    const api = fork(resolveNativeEntryPath(input, "api"), [], { env: runtimeEnv });
    const worker = fork(resolveNativeEntryPath(input, "worker"), [], { env: runtimeEnv });
    children.push(api, worker);
    const limit = input.maxRestarts ?? 2;
    let restarts = 0;
    for (const child of [api, worker]) child.once("exit", () => { if (started && restarts++ < limit) fork(resolveNativeEntryPath(input, child === api ? "api" : "worker"), [], { env: runtimeEnv }); });
    const webDir = input.webDir ?? (input.packaged ? path.join(input.resourcesPath ?? "", "web") : path.resolve(input.appPath ?? process.cwd(), "..", "..", "apps", "web", "dist"));
    webServer = input.serveWeb === false ? undefined : createServer(async (req, res) => {
      const requested = decodeURIComponent((req.url ?? "/").split("?")[0] || "/");
      const file = path.join(webDir, requested === "/" ? "index.html" : requested.replace(/^\//, ""));
      try { const body = await readFile(file); res.statusCode = 200; res.end(body); } catch { res.statusCode = 404; res.end("Not found"); }
    });
    const webPort = await allocatePort();
    if (webServer) await new Promise<void>((resolve, reject) => { webServer!.once("error", reject).listen(webPort, "127.0.0.1", () => resolve()); });
    const url = `http://127.0.0.1:${apiPort}`;
    const deadline = Date.now() + (input.healthTimeoutMs ?? 30_000);
    while (Date.now() < deadline) { try { if ((await fetchImpl(`${url}/health`)).ok) { started = true; currentUrl = `http://127.0.0.1:${webPort}`; return { webUrl: currentUrl }; } } catch {} await sleep(100); }
    await stop();
    throw new Error("Native API health check timed out.");
  }
  let currentUrl: string | undefined;
  async function stop() {
    started = false;
    const server = webServer;
    webServer = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const child of children.splice(0)) child.kill();
  }
  return { start, stop };
}
