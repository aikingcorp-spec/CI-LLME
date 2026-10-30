import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHost } from "@rakazo/contracts/network-host";

/**
 * The slice of `@rakazo/p2p-prototype` used here. Desktop does not depend on that package,
 * so its shapes are restated and the bundle in `p2p/agent-entry.ts` supplies the values.
 */
export interface P2PKeyPair {
  publicKey: string;
  privateKey: string;
}
export interface P2PNodeKeyFile extends P2PKeyPair {
  gatewayPublicKey?: string;
  user?: string;
}
export interface P2PChannelHandler {
  call(
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  subscribe(
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}
export interface P2PNodeAgent {
  close(): Promise<void>;
  connected(): boolean;
}
export interface P2PNodeAgentOptions {
  gatewayUrl: string;
  nodeId: string;
  keyPair: P2PKeyPair;
  handler: (req: unknown) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  }>;
  channel: { gatewayPublicKey: string; allowedUsers: Iterable<string>; handler: P2PChannelHandler };
}

export const P2P_GATEWAY_ENV = "RAKAZO_P2P_GATEWAY_URL";
export const P2P_PAIR_CODE_ENV = "RAKAZO_P2P_PAIR_CODE";
/** Development only: a bundle of `p2p-agent-entry.ts` built outside `apps/desktop/dist`. */
export const P2P_AGENT_MODULE_ENV = "RAKAZO_P2P_AGENT_MODULE";

const P2P_DIR_NAME = "p2p";
const KEY_FILE_NAME = "node-key.json";
const NODE_ID_FILE_NAME = "node-id";
const AGENT_FILE_NAME = "p2p-agent.js";
const PREBUILD_PACKAGE = "node-datachannel";

/** What `p2p-agent-entry.ts` exports; loaded lazily so a missing native binary cannot crash startup. */
export interface P2PAgentModule {
  startNodeAgent(options: P2PNodeAgentOptions): P2PNodeAgent;
  completePairing(
    gatewayUrl: string,
    code: string,
    nodeId: string,
    keyPair: P2PKeyPair,
  ): Promise<{ gatewayPublicKey: string; user: string }>;
  generateKeyPair(): P2PKeyPair;
  readKeyFile(file: string): P2PNodeKeyFile | undefined;
  writeKeyFile(file: string, identity: P2PNodeKeyFile): void;
  forwardChannelHandler(target: string): P2PChannelHandler;
}

export type P2PUnavailableReason =
  | "bad-gateway-url"
  | "no-prebuild"
  | "load-failed"
  | "not-paired"
  | "start-failed";

export type P2PStatus =
  | { state: "off" }
  | { state: "starting" }
  | { state: "running"; nodeId: string }
  | { state: "unavailable"; reason: P2PUnavailableReason; message: string };

/** Vietnamese first, English second; fixed text so no URL, code or key can leak into a log. */
export function p2pUnavailableMessage(reason: P2PUnavailableReason, platform: string): string {
  switch (reason) {
    case "bad-gateway-url":
      return "Địa chỉ cổng P2P không hợp lệ (cần https, hoặc http trên máy này). / The P2P gateway address is not valid (https, or http on this machine, is required).";
    case "no-prebuild":
      return `P2P chưa dùng được trên máy này: thiếu thư viện node-datachannel cho ${platform}. / P2P is unavailable on this machine: the node-datachannel binary for ${platform} is missing.`;
    case "load-failed":
      return "P2P chưa dùng được: không tải được thư viện kết nối. / P2P is unavailable: the connection library could not be loaded.";
    case "not-paired":
      return "Máy chưa được ghép nối với tài khoản: cần mã ghép nối. / This computer is not paired with an account: a pairing code is required.";
    case "start-failed":
      return "Không kết nối được cổng P2P. / Could not reach the P2P gateway.";
  }
}

interface InstallLayout {
  platform: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  pathModule?: Pick<typeof path, "join">;
}

const pathFor = (input: Pick<InstallLayout, "platform" | "pathModule">) =>
  input.pathModule ?? (input.platform === "win32" ? path.win32 : path.posix);

/**
 * Where the installed app keeps node-datachannel's native addon. Packaged builds unpack it
 * from the asar archive; development resolves the package normally, so there is nothing to check.
 */
export function nodeDatachannelBinaryDir(input: InstallLayout): string | null {
  if (!input.packaged) return null;
  return pathFor(input).join(
    input.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    PREBUILD_PACKAGE,
    "build",
    "Release",
  );
}

/** Whether the unpacked directory holds a native addon for this platform. */
export async function hasNativeAddon(
  dir: string,
  list: (dir: string) => Promise<string[]> = (target) => readdir(target),
): Promise<boolean> {
  try {
    return (await list(dir)).some((name) => name.endsWith(".node"));
  } catch {
    return false;
  }
}

/** The bundle of the node agent: inside the app archive when packaged, in `dist` in development. */
export function p2pAgentModulePath(input: InstallLayout & { env?: NodeJS.ProcessEnv }): string {
  const override = input.packaged ? undefined : input.env?.[P2P_AGENT_MODULE_ENV]?.trim();
  return override || pathFor(input).join(input.appPath, "dist", AGENT_FILE_NAME);
}

/** The gateway origin, or null when it is not https (or http on loopback, for local proofs). */
export function parseGatewayUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const secure = url.protocol === "https:";
    const local = url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (!secure && !local) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Serves the data channel from the local API. Only `health` and `/rpc/*` calls pass, so a
 * remote client cannot reach any other path of the local web origin.
 */
export function desktopChannelHandler(
  webUrl: string,
  rpc: P2PChannelHandler,
  request: typeof fetch = fetch,
): P2PChannelHandler {
  return {
    async call(procedure, headers, body) {
      if (procedure !== "health") return rpc.call(procedure, headers, body);
      const res = await request(new URL("/health", webUrl), { method: "GET" });
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
    subscribe: (procedure, headers, body, signal) =>
      rpc.subscribe(procedure, headers, body, signal),
  };
}

export interface P2PNodeOptions extends InstallLayout {
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  /** Gateway URL from saved settings; the environment variable wins. */
  gatewayUrl?: string;
  loadAgent?: (file: string) => Promise<P2PAgentModule>;
  list?: (dir: string) => Promise<string[]>;
  readText?: (file: string) => Promise<string | null>;
  writeText?: (file: string, text: string) => Promise<void>;
  ensureDir?: (dir: string) => Promise<void>;
  randomHex?: (bytes: number) => string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

const loadAgentFromFile = async (file: string) =>
  (await import(pathToFileURL(file).href)) as P2PAgentModule;

const readTextOrNull = async (file: string) => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * Runs the node agent in the main process once the local stack is healthy. A node pairs once
 * with a code from the gateway; later starts reuse its saved key. Anything that is missing turns
 * P2P off with a status message and never throws into startup.
 */
export class P2PNode {
  private current: P2PStatus = { state: "off" };
  private agent: P2PNodeAgent | null = null;
  private generation = 0;
  private startedFor: string | null = null;

  constructor(private readonly options: P2PNodeOptions) {}

  status(): P2PStatus {
    return this.current;
  }

  connected(): boolean {
    return this.agent?.connected() ?? false;
  }

  async start(webUrl: string): Promise<P2PStatus> {
    const configured = (this.options.env[P2P_GATEWAY_ENV] || this.options.gatewayUrl || "").trim();
    if (!configured) return this.set({ state: "off" });
    if (this.startedFor === webUrl && this.current.state === "running") return this.current;
    await this.stop();
    const generation = ++this.generation;
    this.set({ state: "starting" });
    const unavailable = (reason: P2PUnavailableReason) =>
      this.set({
        state: "unavailable",
        reason,
        message: p2pUnavailableMessage(reason, this.options.platform),
      });
    const gatewayUrl = parseGatewayUrl(configured);
    if (!gatewayUrl) return unavailable("bad-gateway-url");

    const binaryDir = nodeDatachannelBinaryDir(this.options);
    if (binaryDir && !(await hasNativeAddon(binaryDir, this.options.list))) {
      return unavailable("no-prebuild");
    }
    let agent: P2PAgentModule;
    try {
      agent = await (this.options.loadAgent ?? loadAgentFromFile)(p2pAgentModulePath(this.options));
    } catch {
      return unavailable("load-failed");
    }
    if (generation !== this.generation) return this.current;

    let identity: { nodeId: string; key: P2PNodeKeyFile } | null;
    try {
      identity = await this.loadIdentity(agent, gatewayUrl);
    } catch {
      return generation === this.generation ? unavailable("start-failed") : this.current;
    }
    if (generation !== this.generation) return this.current;
    if (!identity) return unavailable("not-paired");
    const { nodeId, key } = identity;
    if (!key.gatewayPublicKey || !key.user) return unavailable("not-paired");

    try {
      this.agent = agent.startNodeAgent({
        gatewayUrl,
        nodeId,
        keyPair: key,
        // The gateway's plaintext HTTP relay is off; only the data channel carries requests.
        handler: async () => ({ status: 404, headers: {}, body: new Uint8Array() }),
        channel: {
          gatewayPublicKey: key.gatewayPublicKey,
          allowedUsers: [key.user],
          handler: desktopChannelHandler(
            webUrl,
            agent.forwardChannelHandler(webUrl),
            this.options.fetch,
          ),
        },
      });
    } catch {
      return unavailable("start-failed");
    }
    this.startedFor = webUrl;
    this.options.log?.(`P2P node ${nodeId} is dialing the gateway.`);
    return this.set({ state: "running", nodeId });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const agent = this.agent;
    this.agent = null;
    this.startedFor = null;
    if (this.current.state !== "off") this.current = { state: "off" };
    await agent?.close().catch(() => undefined);
  }

  private set(status: P2PStatus): P2PStatus {
    this.current = status;
    if (status.state === "unavailable") this.options.log?.(status.message);
    return status;
  }

  private files() {
    const dir = pathFor(this.options).join(this.options.userDataDir, P2P_DIR_NAME);
    const join = pathFor(this.options).join;
    return { dir, keyFile: join(dir, KEY_FILE_NAME), idFile: join(dir, NODE_ID_FILE_NAME) };
  }

  private async loadIdentity(agent: P2PAgentModule, gatewayUrl: string) {
    const { dir, keyFile, idFile } = this.files();
    const read = this.options.readText ?? readTextOrNull;
    const saved = agent.readKeyFile(keyFile);
    const savedId = (await read(idFile))?.trim();
    if (saved && savedId) return { nodeId: savedId, key: saved };

    const code = this.options.env[P2P_PAIR_CODE_ENV]?.trim();
    if (!code) return null;
    const nodeId = `desktop-${(this.options.randomHex ?? defaultRandomHex)(8)}`;
    const keyPair = agent.generateKeyPair();
    const { gatewayPublicKey, user } = await agent.completePairing(
      gatewayUrl,
      code,
      nodeId,
      keyPair,
    );
    const key: P2PNodeKeyFile = { ...keyPair, gatewayPublicKey, user };
    // Saved only after the gateway accepted the pairing, so a failed attempt leaves nothing behind.
    await (
      this.options.ensureDir ??
      ((target) => mkdir(target, { recursive: true, mode: 0o700 }).then(() => undefined))
    )(dir);
    agent.writeKeyFile(keyFile, key);
    await (this.options.writeText ?? ((file, text) => writeFile(file, text, { mode: 0o600 })))(
      idFile,
      `${nodeId}\n`,
    );
    return { nodeId, key };
  }
}

const defaultRandomHex = (bytes: number) => randomBytes(bytes).toString("hex");
