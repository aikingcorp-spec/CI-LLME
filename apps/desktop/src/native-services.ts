import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer, request } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { utilityProcess } from "electron";
import { isElevatedProcess } from "./elevation.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export interface UtilityChild {
  once(event: string, listener: (...args: unknown[]) => void): this;
  kill(): void;
}
export type UtilityFork = (
  entry: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
) => UtilityChild;

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
  isPortFree?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  healthTimeoutMs?: number;
  maxRestarts?: number;
  webDir?: string;
  serveWeb?: boolean;
  /** Replaced in tests; the real check asks the operating system. */
  elevated?: () => boolean;
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
  SCREEN_PROXY_SECRET: 32,
  SANDBOX_SUPERVISOR_TOKEN: 32,
  // Lets this app, and nothing else, open a session on its own node.
  RAKAZO_DESKTOP_STACK_TOKEN: 32,
};
const ENV_FILE = "native-stack-env";

function randomHex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

async function loadEnv(
  userDataDir: string,
  supplied: Record<string, string>,
  base: NodeJS.ProcessEnv,
) {
  await mkdir(userDataDir, { recursive: true });
  const file = path.join(userDataDir, ENV_FILE);
  let values: Record<string, string> = {};
  const raw = await readPrivateFile(file, 64 * 1024);
  if (raw) {
    try {
      values = JSON.parse(raw) as Record<string, string>;
    } catch {
      values = {};
    }
  }
  for (const [name, bytes] of Object.entries(SECRET_BYTES)) values[name] ??= randomHex(bytes);
  values = { ...values, ...supplied };
  await writePrivateFile(file, JSON.stringify(values));
  return { ...base, ...values };
}

/** The private token the native services started with, for the main process alone. */
export async function readNativeStackToken(userDataDir: string): Promise<string | null> {
  const raw = await readPrivateFile(path.join(userDataDir, ENV_FILE), 64 * 1024);
  try {
    const token = raw === null ? null : JSON.parse(raw).RAKAZO_DESKTOP_STACK_TOKEN;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

export function resolveNativeEntryPath(
  input: Pick<NativeServicesDeps, "packaged" | "resourcesPath" | "appPath" | "pathModule">,
  packageName: "api" | "worker",
) {
  const p = input.pathModule ?? path;
  const root = input.packaged
    ? p.join(input.resourcesPath ?? "", "server")
    : p.resolve(input.appPath ?? process.cwd(), "..", "..", "apps");
  return p.join(root, packageName, "dist", "index.js");
}

/** Stable per-user location for the native API port, including Windows profiles. */
export function nativePortFilePath(userDataDir: string, pathModule: typeof path = path) {
  return pathModule.join(userDataDir, "native-api-port");
}

/**
 * The web origin is the browser's storage key (language, drafts, mode), so the port stays the
 * same from one launch to the next.
 */
export function nativeWebPortFilePath(userDataDir: string, pathModule: typeof path = path) {
  return pathModule.join(userDataDir, "native-web-port");
}

function parsePort(raw: string | null): number | null {
  if (raw === null || !/^\d{4,5}$/.test(raw.trim())) return null;
  const port = Number(raw.trim());
  return port >= 1024 && port <= 65535 ? port : null;
}

function portIsFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Reuses the saved web port while it is free; a busy one is replaced, and the new one saved. */
export async function chooseNativeWebPort(input: {
  userDataDir: string;
  reserved: number[];
  allocatePort: () => Promise<number>;
  isFree?: (port: number) => Promise<boolean>;
  pathModule?: typeof path;
}): Promise<number> {
  const file = nativeWebPortFilePath(input.userDataDir, input.pathModule);
  const saved = parsePort(await readPrivateFile(file, 32).catch(() => null));
  if (
    saved !== null &&
    !input.reserved.includes(saved) &&
    (await (input.isFree ?? portIsFree)(saved))
  )
    return saved;
  const port = await input.allocatePort();
  await writePrivateFile(file, String(port));
  return port;
}

function defaultPort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) =>
        error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

export function createNativeServices(input: NativeServicesDeps): NativeServices {
  const envBase = input.env ?? process.env;
  const fork: UtilityFork =
    input.fork ??
    ((entry, args, options) =>
      utilityProcess.fork(entry, args, options) as unknown as UtilityChild);
  const fetchImpl = input.fetch ?? fetch;
  const allocatePort = input.allocatePort ?? defaultPort;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const children: UtilityChild[] = [];
  let webServer: Server | undefined;
  const sockets = new Set<Duplex>();
  let started = false;

  async function start(extra: Record<string, string> = {}) {
    if (started) return { webUrl: currentUrl! };
    try {
      const env = await loadEnv(input.userDataDir, extra, envBase);
      const apiPort = await allocatePort();
      const workerPort = await allocatePort();
      const webPort = await chooseNativeWebPort({
        userDataDir: input.userDataDir,
        reserved: [apiPort, workerPort],
        allocatePort,
        isFree: input.isPortFree,
      });
      const webUrl = `http://127.0.0.1:${webPort}`;
      const runtimeEnv: NodeJS.ProcessEnv = {
        ...env,
        DATABASE_URL:
          env.DATABASE_URL ?? `postgresql://127.0.0.1:${env.POSTGRES_PORT ?? "5432"}/rakazo`,
        API_PORT: String(apiPort),
        WORKER_PORT: String(workerPort),
        // Loopback only: the session route trusts whoever holds the token on this computer.
        API_HOST: "127.0.0.1",
        AUTH_PASSWORD_ENABLED: "false",
        SANDBOX_PROVIDER: "desktop",
        // Bot commands never run with administrator or root rights; the backend refuses them
        // while the app itself runs that way.
        ...((input.elevated ?? isElevatedProcess)() ? { RAKAZO_HOST_COMMANDS_ELEVATED: "1" } : {}),
        WEB_ORIGIN: webUrl,
        BETTER_AUTH_URL: webUrl,
      };
      delete runtimeEnv.DATABASE_MIGRATION_URL;
      // Relative paths in the services (the job runner's crontab, ./data) resolve under the
      // user's data folder, not wherever the app was launched from.
      const childOptions = { env: runtimeEnv, cwd: input.userDataDir };
      // No recurring tasks are built in; an empty file keeps the runner from warning about a missing one.
      await writePrivateFile(path.join(input.userDataDir, "crontab"), "# No recurring tasks.\n");
      const api = fork(resolveNativeEntryPath(input, "api"), [], childOptions);
      children.push(api);
      const worker = fork(resolveNativeEntryPath(input, "worker"), [], childOptions);
      children.push(worker);
      let startupFailed = false;
      let startupDetail = "Native service exited during startup.";
      const watch = (child: UtilityChild, name: "api" | "worker", attempts = 0) => {
        child.once("error", () => {
          if (!started) {
            startupFailed = true;
            startupDetail = `Native ${name} process reported an error.`;
          }
        });
        child.once("exit", (code) => {
          if (!started) {
            startupFailed = true;
            startupDetail = `Native ${name} process exited with code ${String(code)}.`;
            return;
          }
          if (attempts >= (input.maxRestarts ?? 2)) return;
          try {
            const replacement = fork(resolveNativeEntryPath(input, name), [], childOptions);
            children.push(replacement);
            watch(replacement, name, attempts + 1);
          } catch {
            /* A failed restart must not crash the Electron main process. */
          }
        });
      };
      watch(api, "api");
      watch(worker, "worker");
      await writePrivateFile(nativePortFilePath(input.userDataDir), String(apiPort));
      const webDir =
        input.webDir ??
        (input.packaged
          ? path.join(input.resourcesPath ?? "", "web")
          : path.resolve(input.appPath ?? process.cwd(), "..", "..", "apps", "web", "dist"));
      webServer =
        input.serveWeb === false
          ? undefined
          : createServer(async (req, res) => {
              const pathname = (req.url ?? "/").split("?")[0]!;
              if (
                pathname === "/health" ||
                pathname === "/rpc" ||
                pathname.startsWith("/rpc/") ||
                pathname === "/api" ||
                pathname.startsWith("/api/") ||
                pathname.startsWith("/.well-known/")
              ) {
                const upstream = request(
                  {
                    hostname: "127.0.0.1",
                    port: apiPort,
                    path: req.url,
                    method: req.method,
                    headers: req.headers,
                  },
                  (response) => {
                    res.writeHead(response.statusCode ?? 502, response.headers);
                    response.pipe(res);
                  },
                );
                upstream.on("error", () => {
                  if (!res.headersSent) res.writeHead(502);
                  res.end();
                });
                res.on("close", () => upstream.destroy());
                req.pipe(upstream);
                return;
              }
              try {
                const requested = decodeURIComponent(pathname);
                const file = path.resolve(webDir, `.${requested}`);
                const relative = path.relative(webDir, file);
                if (relative.startsWith("..") || path.isAbsolute(relative)) {
                  res.writeHead(403).end();
                  return;
                }
                const extension = path.extname(file);
                const target = extension ? file : path.join(webDir, "index.html");
                const body = await readFile(target);
                const types: Record<string, string> = {
                  ".html": "text/html",
                  ".js": "text/javascript",
                  ".css": "text/css",
                  ".json": "application/json",
                  ".svg": "image/svg+xml",
                  ".png": "image/png",
                  ".woff2": "font/woff2",
                };
                res.setHeader(
                  "Content-Type",
                  types[path.extname(target)] ?? "application/octet-stream",
                );
                res.end(body);
              } catch {
                res.writeHead(404).end();
              }
            });
      webServer?.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      webServer?.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/api/")) {
          socket.destroy();
          return;
        }
        const upstream = request({
          hostname: "127.0.0.1",
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        });
        upstream.once("upgrade", (response, peer, peerHead) => {
          socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
          for (let i = 0; i < response.rawHeaders.length; i += 2) {
            socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
          }
          socket.write("\r\n");
          if (peerHead.length) socket.write(peerHead);
          if (head.length) peer.write(head);
          socket.pipe(peer).pipe(socket);
          socket.once("close", () => peer.destroy());
          peer.once("error", () => socket.destroy());
          peer.once("close", () => socket.destroy());
        });
        upstream.once("response", (response) => {
          response.resume();
          socket.destroy();
        });
        upstream.once("error", () => socket.destroy());
        socket.once("error", () => upstream.destroy());
        socket.once("close", () => upstream.destroy());
        upstream.end();
      });
      if (webServer)
        await new Promise<void>((resolve, reject) => {
          webServer!.once("error", reject).listen(webPort, "127.0.0.1", () => resolve());
        });
      const url = `http://127.0.0.1:${apiPort}`;
      const deadline = Date.now() + (input.healthTimeoutMs ?? 30_000);
      while (Date.now() < deadline) {
        if (startupFailed) throw new Error(startupDetail);
        try {
          if (
            (await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok &&
            !startupFailed
          ) {
            started = true;
            currentUrl = webUrl;
            return { webUrl: currentUrl };
          }
        } catch {}
        await sleep(100);
      }
      throw new Error("Native API health check timed out.");
    } catch (error) {
      await stop();
      throw new Error("Native services could not start.", { cause: error });
    }
  }
  let currentUrl: string | undefined;
  async function stop() {
    started = false;
    const server = webServer;
    webServer = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const child of children.splice(0)) child.kill();
  }
  return { start, stop };
}
