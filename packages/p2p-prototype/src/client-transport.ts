import { randomUUID } from "node:crypto";
import type { ChannelFrame } from "./channel-protocol.js";
import { decodeBytes, decodeChannelFrame, encodeBytes } from "./channel-protocol.js";
import type { DataPeer, PeerOptions } from "./webrtc-peer.js";
import { connectPeer } from "./webrtc-peer.js";

export interface ClientCall {
  procedure: string;
  body: Uint8Array;
  headers: Record<string, string>;
  signal: AbortSignal;
}
export interface ClientResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export interface ClientTransport {
  call(request: ClientCall): Promise<ClientResponse>;
  subscribe(request: ClientCall): AsyncIterable<Uint8Array>;
}
export class HttpClientTransport implements ClientTransport {
  constructor(
    private readonly options: {
      baseUrl: string;
      nodeId: string;
      sessionToken: string;
      fetch?: typeof fetch;
    },
  ) {}
  async call(req: ClientCall): Promise<ClientResponse> {
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${this.options.sessionToken}`);
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.baseUrl.replace(/\/$/, "")}/nodes/${encodeURIComponent(this.options.nodeId)}/rpc/${req.procedure.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "POST",
        headers,
        body: req.body,
        signal: req.signal,
      },
    );
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  }
  /** v0 buffers the full response; true HTTP streaming requires a relay protocol change. */
  async *subscribe(req: ClientCall): AsyncIterable<Uint8Array> {
    const response = await this.call({
      ...req,
      headers: { ...req.headers, accept: "text/event-stream" },
    });
    req.signal.throwIfAborted();
    if (response.status < 200 || response.status >= 300)
      throw new Error(`subscribe failed: ${response.status}`);
    yield response.body;
  }
}
function inbox<T>() {
  const items: T[] = [];
  let ended = false;
  let error: unknown;
  let wake: (() => void) | undefined;
  return {
    push(item: T) {
      if (!ended) {
        items.push(item);
        wake?.();
      }
    },
    end(reason?: unknown) {
      ended = true;
      error = reason;
      if (reason) items.length = 0;
      wake?.();
    },
    async *read(): AsyncIterable<T> {
      while (true) {
        if (error) throw error;
        const item = items.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
export class DataChannelClientTransport implements ClientTransport {
  private bearer: string | undefined;
  private failure: Error | undefined;
  private readonly pending = new Map<string, ReturnType<typeof inbox<ChannelFrame>>>();
  private readonly handshake = inbox<string>();
  readonly ready: Promise<void>;
  constructor(
    private readonly peer: DataPeer,
    assertion: string,
  ) {
    this.ready = (async () => {
      await peer.open;
      peer.send(JSON.stringify({ t: "hello", assertion }));
      for await (const bearer of this.handshake.read()) {
        this.bearer = bearer;
        return;
      }
      throw new Error("channel closed");
    })();
    void this.ready.catch(() => {});
    void this.receive();
  }
  static async connect(
    options: PeerOptions & { assertion: string },
  ): Promise<DataChannelClientTransport> {
    const peer = await connectPeer(options);
    const client = new DataChannelClientTransport(peer, options.assertion);
    try {
      await client.ready;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  selectedPair(): ReturnType<DataPeer["selectedPair"]> {
    return this.peer.selectedPair();
  }
  close(): void {
    this.fail(new Error("channel closed"));
    this.peer.close();
  }
  private fail(error: Error): void {
    this.failure = error;
    this.handshake.end(error);
    for (const queue of this.pending.values()) queue.end(error);
  }
  private async receive(): Promise<void> {
    try {
      for await (const raw of this.peer.messages) {
        const frame = decodeChannelFrame(raw);
        if (frame.t === "denied") throw new Error("denied");
        if (frame.t === "welcome" && !this.bearer) {
          this.handshake.push(frame.bearer);
          continue;
        }
        if (!("bearer" in frame) || frame.bearer !== this.bearer || !("id" in frame))
          throw new Error("invalid server frame");
        const queue = this.pending.get(frame.id);
        if (!queue) continue;
        if (frame.t === "error") queue.end(new Error(frame.message));
        else if (frame.t === "end") queue.end();
        else if (frame.t === "response" || frame.t === "chunk") queue.push(frame);
        else throw new Error("invalid server frame");
      }
      this.fail(new Error("channel closed"));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("channel failed"));
      this.peer.close();
    }
  }
  private async *request(req: ClientCall, t: "call" | "subscribe"): AsyncIterable<ChannelFrame> {
    req.signal.throwIfAborted();
    const id = randomUUID();
    const queue = inbox<ChannelFrame>();
    let sent = false;
    const cancel = (): void => {
      queue.end(req.signal.reason ?? new Error("aborted"));
      if (sent && !this.failure)
        this.peer.send(JSON.stringify({ t: "cancel", id, bearer: this.bearer }));
    };
    req.signal.addEventListener("abort", cancel, { once: true });
    this.pending.set(id, queue);
    try {
      void this.ready
        .then(() => {
          req.signal.throwIfAborted();
          if (this.failure) throw this.failure;
          this.peer.send(
            JSON.stringify({
              t,
              id,
              bearer: this.bearer,
              procedure: req.procedure,
              headers: req.headers,
              body: encodeBytes(req.body),
            }),
          );
          sent = true;
        })
        .catch((error: unknown) => queue.end(error));
      for await (const frame of queue.read()) yield frame;
    } finally {
      if (sent && !this.failure && !req.signal.aborted)
        this.peer.send(JSON.stringify({ t: "cancel", id, bearer: this.bearer }));
      req.signal.removeEventListener("abort", cancel);
      this.pending.delete(id);
    }
  }
  async call(req: ClientCall): Promise<ClientResponse> {
    for await (const frame of this.request(req, "call")) {
      if (frame.t !== "response") throw new Error("expected response");
      return { status: frame.status, headers: frame.headers, body: decodeBytes(frame.body) };
    }
    throw new Error("missing response");
  }
  async *subscribe(req: ClientCall): AsyncIterable<Uint8Array> {
    for await (const frame of this.request(req, "subscribe")) {
      if (frame.t !== "chunk") throw new Error("expected chunk");
      yield decodeBytes(frame.data);
    }
  }
}
