import { createChannelFraming } from "./channel-framing.js";
import type { ChannelFrame } from "./channel-protocol.js";
import { decodeBytes, encodeBytes } from "./channel-protocol.js";
import type { DataPeer } from "./peer-core.js";

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
  private readonly framing;
  private bearer: string | undefined;
  private failure: Error | undefined;
  private readonly pending = new Map<string, ReturnType<typeof inbox<ChannelFrame>>>();
  private readonly handshake = inbox<string>();
  readonly ready: Promise<void>;
  constructor(
    private readonly peer: DataPeer,
    assertion: string,
  ) {
    const framing = createChannelFraming((raw) => peer.send(raw));
    this.framing = framing;
    this.ready = (async () => {
      try {
        await peer.open;
      } catch (cause) {
        throw new Error("denied: channel closed before welcome", { cause });
      }
      framing.send({ t: "hello", assertion, fragmentation: true });
      for await (const bearer of this.handshake.read()) {
        this.bearer = bearer;
        return;
      }
      throw new Error("channel closed");
    })();
    void this.ready.catch(() => {});
    void this.receive();
  }
  selectedPair(): ReturnType<DataPeer["selectedPair"]> {
    return this.peer.selectedPair();
  }
  async renew(assertion: string, signal: AbortSignal): Promise<void> {
    await this.ready;
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    const id = globalThis.crypto.randomUUID();
    const queue = inbox<ChannelFrame>();
    const abort = () => queue.end(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    this.pending.set(id, queue);
    try {
      this.framing.send({ t: "renew", id, bearer: this.bearer!, assertion });
      for await (const frame of queue.read()) {
        if (frame.t !== "renewed") throw new Error("expected renewal acknowledgement");
        return;
      }
      throw new Error("missing renewal acknowledgement");
    } finally {
      signal.removeEventListener("abort", abort);
      this.pending.delete(id);
    }
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
        const frame = this.framing.receive(raw);
        if (!frame) continue;
        if (frame.t === "denied") throw new Error("denied");
        if (frame.t === "welcome" && !this.bearer) {
          if (frame.fragmentation) this.framing.enable(frame.bearer);
          this.handshake.push(frame.bearer);
          continue;
        }
        if (!("bearer" in frame) || frame.bearer !== this.bearer || !("id" in frame))
          throw new Error("invalid server frame");
        const queue = this.pending.get(frame.id);
        if (!queue) continue;
        if (frame.t === "error") queue.end(new Error(frame.message));
        else if (frame.t === "end") queue.end();
        else if (frame.t === "response" || frame.t === "chunk" || frame.t === "renewed")
          queue.push(frame);
        else throw new Error("invalid server frame");
      }
      this.fail(
        new Error(this.bearer ? "channel closed" : "denied: channel closed before welcome"),
      );
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error("channel failed"));
      this.peer.close();
    }
  }
  private async *request(req: ClientCall, t: "call" | "subscribe"): AsyncIterable<ChannelFrame> {
    req.signal.throwIfAborted();
    const id = globalThis.crypto.randomUUID();
    const queue = inbox<ChannelFrame>();
    let sent = false;
    const cancel = (): void => {
      queue.end(req.signal.reason ?? new Error("aborted"));
      if (sent && !this.failure) this.sendCancel(id);
    };
    req.signal.addEventListener("abort", cancel, { once: true });
    this.pending.set(id, queue);
    try {
      void this.ready
        .then(() => {
          req.signal.throwIfAborted();
          if (this.failure) throw this.failure;
          this.framing.send({
            t,
            id,
            bearer: this.bearer!,
            procedure: req.procedure,
            headers: req.headers,
            body: encodeBytes(req.body),
          });
          sent = true;
        })
        .catch((error: unknown) => queue.end(error));
      for await (const frame of queue.read()) yield frame;
    } finally {
      if (sent && !this.failure && !req.signal.aborted) this.sendCancel(id);
      req.signal.removeEventListener("abort", cancel);
      this.pending.delete(id);
    }
  }
  private sendCancel(id: string): void {
    try {
      this.framing.send({ t: "cancel", id, bearer: this.bearer! });
    } catch {
      this.fail(new Error("channel closed"));
      this.peer.close();
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
