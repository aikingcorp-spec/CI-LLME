import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHost } from "@rakazo/contracts/network-host";
import type { IceServer } from "node-datachannel";

/** Resolve just before each incoming connection, so an idle node never reuses expired TURN. */
export async function desktopIceServers(
  gatewayUrl: string,
  nodeId: string,
  key: P2PKeyPair,
  resolveTurn: (gatewayUrl: string, nodeId: string, key: P2PKeyPair) => Promise<IceServer[]>,
  stunServers: string[] = ["stun:stun.l.google.com:19302"],
) {
  try {
    return [...stunServers, ...(await resolveTurn(gatewayUrl, nodeId, key))];
  } catch {
    return [...stunServers];
  }
}

/**
 * The slice of `@rakazo/p2p-prototype` used for pairing. Desktop does not depend on that
 * package, so the shapes are restated and `p2p/pairing-entry.ts` supplies the values.
 */
export interface P2PKeyPair {
  publicKey: string;
  privateKey: string;
}
export interface P2PNodeKeyFile extends P2PKeyPair {
  gatewayPublicKey?: string;
  user?: string;
}
export interface P2PPairingModule {
  completePairing(
    gatewayUrl: string,
    code: string,
    nodeId: string,
    keyPair: P2PKeyPair,
  ): Promise<{ gatewayPublicKey: string; user: string }>;
  generateKeyPair(): P2PKeyPair;
  readKeyFile(file: string): P2PNodeKeyFile | undefined;
  writeKeyFile(file: string, identity: P2PNodeKeyFile): void;
}

/** An Electron utility process, or any child that speaks the same two-message protocol. */
export interface P2PChild {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
  kill(): unknown;
}

export const P2P_GATEWAY_ENV = "RAKAZO_P2P_GATEWAY_URL";
export const P2P_PAIR_CODE_ENV = "RAKAZO_P2P_PAIR_CODE";
/** Development only: the agent bundle built outside `apps/desktop/dist`, next to node-datachannel. */
export const P2P_AGENT_MODULE_ENV = "RAKAZO_P2P_AGENT_MODULE";

const P2P_DIR_NAME = "p2p";
const KEY_FILE_NAME = "node-key.json";
const NODE_ID_FILE_NAME = "node-id";
const AGENT_FILE_NAME = "p2p-agent.js";
const PAIRING_FILE_NAME = "p2p-pairing.js";
const PREBUILD_PACKAGE = "node-datachannel";
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const CHILD_ENV_KEYS = ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "P2P_DEBUG"];

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
  pathModule?: Pick<typeof path, "join" | "dirname">;
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

/**
 * The agent bundle runs in a utility process; the pairing bundle is loaded by main. Both sit in
 * `dist` of the app archive when packaged. In development the agent bundle can be overridden
 * because `apps/desktop` does not depend on node-datachannel; pairing needs no native module.
 */
export function p2pBundlePaths(input: InstallLayout & { env?: NodeJS.ProcessEnv }): {
  agent: string;
  pairing: string;
} {
  const p = pathFor(input);
  const override = input.packaged ? undefined : input.env?.[P2P_AGENT_MODULE_ENV]?.trim();
  const agent = override || p.join(input.appPath, "dist", AGENT_FILE_NAME);
  const pairing = override
    ? p.join(p.dirname(override), PAIRING_FILE_NAME)
    : p.join(input.appPath, "dist", PAIRING_FILE_NAME);
  return { agent, pairing };
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

export interface P2PNodeOptions extends InstallLayout {
  userDataDir: string;
  env: NodeJS.ProcessEnv;
  /** Gateway URL from saved settings; the environment variable wins. */
  gatewayUrl?: string;
  loadPairing?: (file: string) => Promise<P2PPairingModule>;
  spawnAgent?: (entry: string, env: Record<string, string>) => Promise<P2PChild>;
  list?: (dir: string) => Promise<string[]>;
  readText?: (file: string) => Promise<string | null>;
  writeText?: (file: string, text: string) => Promise<void>;
  ensureDir?: (dir: string) => Promise<void>;
  randomHex?: (bytes: number) => string;
  startTimeoutMs?: number;
  log?: (message: string) => void;
}

const loadPairingFromFile = async (file: string) =>
  (await import(pathToFileURL(file).href)) as P2PPairingModule;

const forkUtility = async (entry: string, env: Record<string, string>): Promise<P2PChild> => {
  const { utilityProcess } = await import("electron");
  return utilityProcess.fork(entry, [], { env, serviceName: "VNBot P2P" }) as unknown as P2PChild;
};

const readTextOrNull = async (file: string) => {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
};

const defaultRandomHex = (bytes: number) => randomBytes(bytes).toString("hex");

/**
 * Runs the node agent in a utility process once the local stack is healthy. A node pairs once
 * with a code from the gateway; later starts reuse its saved key. Anything that is missing turns
 * P2P off with a status message and never throws into startup.
 */
export class P2PNode {
  private current: P2PStatus = { state: "off" };
  private child: P2PChild | null = null;
  private generation = 0;
  private startedFor: string | null = null;

  constructor(private readonly options: P2PNodeOptions) {}

  status(): P2PStatus {
    return this.current;
  }

  async start(webUrl: string): Promise<P2PStatus> {
    const configured = (this.options.env[P2P_GATEWAY_ENV] || this.options.gatewayUrl || "").trim();
    if (!configured) return this.set({ state: "off" });
    if (this.startedFor === webUrl && this.current.state === "running") return this.current;
    await this.stop();
    const generation = ++this.generation;
    const stale = () => generation !== this.generation;
    this.set({ state: "starting" });
    const unavailable = (reason: P2PUnavailableReason) => this.fail(reason);
    const gatewayUrl = parseGatewayUrl(configured);
    if (!gatewayUrl) return unavailable("bad-gateway-url");

    const binaryDir = nodeDatachannelBinaryDir(this.options);
    if (binaryDir && !(await hasNativeAddon(binaryDir, this.options.list))) {
      return unavailable("no-prebuild");
    }
    const bundles = p2pBundlePaths(this.options);
    let pairing: P2PPairingModule;
    try {
      pairing = await (this.options.loadPairing ?? loadPairingFromFile)(bundles.pairing);
    } catch {
      return unavailable("load-failed");
    }
    if (stale()) return this.current;

    let identity: Awaited<ReturnType<P2PNode["loadIdentity"]>>;
    try {
      identity = await this.loadIdentity(pairing, gatewayUrl);
    } catch {
      return stale() ? this.current : unavailable("start-failed");
    }
    if (stale()) return this.current;
    const key = identity?.key;
    if (!identity || !key?.gatewayPublicKey || !key.user) return unavailable("not-paired");

    const outcome = await this.launch(bundles.agent, {
      type: "start",
      gatewayUrl,
      nodeId: identity.nodeId,
      webUrl,
      key: {
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        gatewayPublicKey: key.gatewayPublicKey,
        user: key.user,
      },
    });
    if (stale()) {
      this.child?.kill();
      return this.current;
    }
    if (outcome !== "started") return unavailable(outcome);
    this.startedFor = webUrl;
    this.options.log?.(`P2P node ${identity.nodeId} is dialing the gateway.`);
    return this.set({ state: "running", nodeId: identity.nodeId });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.startedFor = null;
    if (this.current.state !== "off") this.current = { state: "off" };
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, STOP_TIMEOUT_MS);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: "stop" });
    });
  }

  /** `started` once the agent reports it is dialing; a child that dies first could not load. */
  private async launch(
    entry: string,
    message: unknown,
  ): Promise<"started" | "load-failed" | "start-failed"> {
    const env: Record<string, string> = {};
    for (const name of CHILD_ENV_KEYS) {
      const value = this.options.env[name];
      if (value !== undefined) env[name] = value;
    }
    let child: P2PChild;
    try {
      child = await (this.options.spawnAgent ?? forkUtility)(entry, env);
    } catch {
      return "load-failed";
    }
    this.child = child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve("start-failed");
      }, this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      const settle = (result: "started" | "load-failed" | "start-failed") => {
        clearTimeout(timer);
        resolve(result);
      };
      child.on("message", (reply) => {
        const type = (reply as { type?: string } | null)?.type;
        if (type === "started") settle("started");
        else if (type === "error") settle("start-failed");
      });
      child.on("exit", () => {
        if (this.child === child) {
          this.child = null;
          this.startedFor = null;
          if (this.current.state === "running") this.fail("start-failed");
        }
        settle("load-failed");
      });
      child.postMessage(message);
    });
  }

  private fail(reason: P2PUnavailableReason): P2PStatus {
    return this.set({
      state: "unavailable",
      reason,
      message: p2pUnavailableMessage(reason, this.options.platform),
    });
  }

  private set(status: P2PStatus): P2PStatus {
    this.current = status;
    if (status.state === "unavailable") this.options.log?.(status.message);
    return status;
  }

  private async loadIdentity(pairing: P2PPairingModule, gatewayUrl: string) {
    const p = pathFor(this.options);
    const dir = p.join(this.options.userDataDir, P2P_DIR_NAME);
    const keyFile = p.join(dir, KEY_FILE_NAME);
    const idFile = p.join(dir, NODE_ID_FILE_NAME);
    const read = this.options.readText ?? readTextOrNull;
    const saved = pairing.readKeyFile(keyFile);
    const savedId = (await read(idFile))?.trim();
    if (saved && savedId) return { nodeId: savedId, key: saved };

    const code = this.options.env[P2P_PAIR_CODE_ENV]?.trim();
    if (!code) return null;
    const nodeId = `desktop-${(this.options.randomHex ?? defaultRandomHex)(8)}`;
    const keyPair = pairing.generateKeyPair();
    const { gatewayPublicKey, user } = await pairing.completePairing(
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
    pairing.writeKeyFile(keyFile, key);
    await (this.options.writeText ?? ((file, text) => writeFile(file, text, { mode: 0o600 })))(
      idFile,
      `${nodeId}\n`,
    );
    return { nodeId, key };
  }
}
