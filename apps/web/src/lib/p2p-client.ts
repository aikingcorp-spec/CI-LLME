import { p2pGatewayOrigin } from "@rakazo/contracts/content-security-policy";
import type { PairedNode } from "@rakazo/p2p-prototype/browser";
import {
  connectBrowserPeer,
  DataChannelClientTransport,
  fetchTurnCredentials,
  listNodes,
  openSession,
  startPairing,
} from "@rakazo/p2p-prototype/browser";
import { desktopBridge } from "./desktop";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "failed";
export interface P2PSnapshot {
  state: ConnectionState;
  nodeId?: string;
}
export interface P2PConfig {
  gatewayUrl: string;
  iceServers: RTCIceServer[];
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function isStunServerList(value: unknown): value is RTCIceServer[] {
  return (
    Array.isArray(value) &&
    value.every((server) => {
      if (!server || typeof server !== "object") return false;
      const urls: unknown = server.urls;
      const entries: unknown = typeof urls === "string" ? [urls] : urls;
      return (
        Array.isArray(entries) &&
        entries.length > 0 &&
        entries.every((url: unknown) => typeof url === "string" && /^stuns?:[^\s]+$/.test(url))
      );
    })
  );
}

function parseIceServers(raw: string | undefined): RTCIceServer[] {
  if (!raw?.trim()) return DEFAULT_ICE_SERVERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isStunServerList(parsed)) return parsed;
  } catch {
    // The parse error quotes the value, which may hold credentials, so it is never logged.
  }
  console.warn("Ignoring invalid VITE_P2P_ICE_SERVERS; using the default STUN server.");
  return DEFAULT_ICE_SERVERS;
}

export function p2pConfig(env: {
  VITE_P2P_GATEWAY_URL?: string;
  VITE_P2P_ICE_SERVERS?: string;
}): P2PConfig | undefined {
  const gatewayUrl = p2pGatewayOrigin(env.VITE_P2P_GATEWAY_URL);
  if (!gatewayUrl) return undefined;
  return { gatewayUrl, iceServers: parseIceServers(env.VITE_P2P_ICE_SERVERS) };
}

/** Credentials and node data live only in memory; every gateway action mints a fresh scoped token. */
export class WebP2PClient {
  private snapshot: P2PSnapshot = { state: "disconnected" };
  private listeners = new Set<() => void>();
  private attempt?: AbortController;
  private transport?: DataChannelClientTransport;
  private retry?: ReturnType<typeof setTimeout>;
  private retryCount = 0;
  private retryEpoch = 0;
  private accountId?: string;
  constructor(private readonly config: P2PConfig) {}
  getSnapshot = (): P2PSnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(snapshot: P2PSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private async token(scope: "nodes" | "pair" | "session", signal?: AbortSignal, nodeId?: string) {
    const res = await fetch("/api/auth/p2p-token", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: [scope], ...(nodeId ? { nodeId } : {}) }),
      signal,
    });
    if (!res.ok) throw new Error("P2P authorization failed");
    const body = (await res.json()) as { token: string };
    return body.token;
  }
  async nodes(): Promise<PairedNode[]> {
    const signal = AbortSignal.timeout(10_000);
    return (await listNodes(this.config.gatewayUrl, await this.token("nodes", signal), signal))
      .nodes;
  }
  async revoke(nodeId: string) {
    const signal = AbortSignal.timeout(10_000);
    const token = await this.token("nodes", signal, nodeId);
    const response = await fetch(`${this.config.gatewayUrl}/nodes/${encodeURIComponent(nodeId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Could not revoke computer");
    if (this.snapshot.nodeId === nodeId) {
      this.disconnect();
      if (this.accountId) {
        try {
          sessionStorage.removeItem(`vnbot:p2p:${this.accountId}`);
        } catch {
          /* Optional preference. */
        }
      }
    }
  }
  async pair() {
    const signal = AbortSignal.timeout(10_000);
    return startPairing(this.config.gatewayUrl, await this.token("pair", signal), signal);
  }
  async restore(accountId: string) {
    if (this.accountId === accountId) return;
    this.accountId = accountId;
    let nodeId: string | null = null;
    try {
      nodeId = sessionStorage.getItem(`vnbot:p2p:${accountId}`);
    } catch {
      /* Optional preference. */
    }
    if (!nodeId) return;
    const nodes = await this.nodes();
    if (this.accountId !== accountId) return;
    if (nodes.some((node) => node.nodeId === nodeId && node.online)) await this.connect(nodeId);
  }
  private reconnect(nodeId: string) {
    if (this.retryCount >= 5) return;
    const delay = Math.min(1000 * 2 ** this.retryCount++, 15_000);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      const pending = this.connect(nodeId);
      const epoch = this.retryEpoch;
      void pending.catch(() => {
        if (epoch === this.retryEpoch) this.reconnect(nodeId);
      });
    }, delay);
  }
  async connect(nodeId: string): Promise<void> {
    this.disconnect();
    const attempt = new AbortController();
    this.attempt = attempt;
    const timeout = setTimeout(() => attempt.abort(), 20_000);
    this.set({ state: "connecting", nodeId });
    try {
      const token = await this.token("session", attempt.signal, nodeId);
      attempt.signal.throwIfAborted();
      const session = await openSession(
        this.config.gatewayUrl,
        token,
        nodeId,
        crypto.randomUUID(),
        attempt.signal,
      );
      attempt.signal.throwIfAborted();
      const turn = await fetchTurnCredentials(
        this.config.gatewayUrl,
        `Assertion ${session.assertion}`,
        session.peerId,
        attempt.signal,
      );
      attempt.signal.throwIfAborted();
      const peer = await connectBrowserPeer({
        signalUrl: `${this.config.gatewayUrl}/signal`,
        selfId: session.peerId,
        remoteId: session.nodeId,
        initiator: true,
        assertion: session.assertion,
        iceServers: [...this.config.iceServers, ...(turn ? [turn] : [])],
        signal: attempt.signal,
        onClose: () => {
          if (this.attempt === attempt && !attempt.signal.aborted) {
            attempt.abort();
            this.transport = undefined;
            this.set({ state: "connecting", nodeId });
            this.reconnect(nodeId);
          }
        },
      });
      const transport = new DataChannelClientTransport(peer, session.assertion);
      const abort = () => transport.close();
      attempt.signal.addEventListener("abort", abort, { once: true });
      if (attempt.signal.aborted) transport.close();
      await transport.ready;
      attempt.signal.throwIfAborted();
      if (this.attempt !== attempt) {
        transport.close();
        return;
      }
      this.retryCount = 0;
      if (this.accountId) {
        try {
          sessionStorage.setItem(`vnbot:p2p:${this.accountId}`, nodeId);
        } catch {
          /* Optional preference. */
        }
      }
      this.transport = transport;
      this.set({ state: "connected", nodeId });
    } catch (error) {
      if (this.attempt === attempt) {
        attempt.abort();
        this.set({ state: "failed", nodeId });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  disconnect = () => {
    this.retryEpoch++;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.attempt?.abort();
    this.attempt = undefined;
    this.transport?.close();
    this.transport = undefined;
    this.set({ state: "disconnected", nodeId: this.snapshot.nodeId });
  };
  reset = () => {
    this.disconnect();
    this.accountId = undefined;
    this.set({ state: "disconnected" });
  };

  /** Never fall back to the gateway's /rpc after selecting a remote node. */
  async fetch(request: Request, signal: AbortSignal): Promise<Response> {
    const transport = this.transport;
    if (!transport || this.snapshot.state !== "connected") throw new Error("P2P disconnected");
    const procedure = new URL(request.url).pathname
      .slice("/rpc/".length)
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const call = {
      procedure,
      headers: Object.fromEntries(request.headers),
      body: new Uint8Array(await request.arrayBuffer()),
      signal,
    };
    if (procedure.endsWith("/subscribe")) {
      const cancel = new AbortController();
      const iterator = transport
        .subscribe({ ...call, signal: AbortSignal.any([signal, cancel.signal]) })
        [Symbol.asyncIterator]();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
            }
          },
          async cancel() {
            cancel.abort();
            await iterator.return?.();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const response = await transport.call(call);
    return new Response(new Uint8Array(response.body), {
      status: response.status,
      headers: response.headers,
    });
  }
}

// Construct lazily: invalid optional configuration must not break local web/desktop startup.
let client: WebP2PClient | undefined;
/** Undefined when this build has no explicit gateway: no client, token or gateway request exists. */
export function webP2PClient(): WebP2PClient | undefined {
  if (client) return client;
  const config = p2pConfig({
    VITE_P2P_GATEWAY_URL: import.meta.env.VITE_P2P_GATEWAY_URL,
    VITE_P2P_ICE_SERVERS: import.meta.env.VITE_P2P_ICE_SERVERS,
  });
  if (config) client = new WebP2PClient(config);
  return client;
}
export function activeP2PClient(): WebP2PClient | undefined {
  if (typeof window !== "undefined" && !desktopBridge()) return webP2PClient();
  return client?.getSnapshot().nodeId ? client : undefined;
}
export function resetP2PClient(): void {
  client?.reset();
}
