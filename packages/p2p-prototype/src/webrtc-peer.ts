import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import type { DataChannel, IceServer } from "node-datachannel";
import { PeerConnection } from "node-datachannel";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { SignalPayload } from "./protocol.js";
import { decodeGatewayFrame, encodeFrame, toWsUrl } from "./protocol.js";

export type CloseHandshakeEvent = "bye-sent" | "bye-received" | "bye-ack-sent" | "bye-ack-received";

export interface PeerOptions {
  signalUrl: string;
  signal?: AbortSignal;
  /** Node agent multiplexes signaling over its authenticated outbound link. */
  signaling?: {
    send(payload: SignalPayload): void;
    listen(receive: (payload: SignalPayload) => void): () => void;
  };
  selfId: string;
  remoteId: string;
  initiator: boolean;
  /** Sent as the `Authorization` header on the signaling upgrade (`Assertion ...` or `Node ...`). */
  authorization?: string;
  iceServers?: Array<string | IceServer>;
  iceTransportPolicy?: "all" | "relay";
  /** Fallback for a remote that never acknowledges BYE. Default 5000 ms. */
  closeAckTimeoutMs?: number;
  onCloseHandshake?: (event: CloseHandshakeEvent) => void;
}
export interface DataPeer {
  send(text: string): void;
  messages: AsyncIterable<string>;
  open: Promise<void>;
  localCandidates: string[];
  selectedPair(): { local: string; remote: string } | null;
  close(): void;
  closeGracefully(): Promise<void>;
}

const CHANNEL_LABEL = "rakazo";
// Control frames are binary; application messages are always strings, so they never collide.
const BYE = 0x01;
const BYE_ACK = 0x02;
const controlFrame = (code: number): Buffer => Buffer.from([code]);

function createMessageQueue() {
  const items: string[] = [];
  const waiters: Array<(r: IteratorResult<string>) => void> = [];
  let ended = false;
  return {
    push(text: string): void {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: text, done: false });
      else items.push(text);
    },
    end(): void {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string>> => {
          const text = items.shift();
          if (text !== undefined) return Promise.resolve({ value: text, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      }),
    } satisfies AsyncIterable<string>,
  };
}

export async function connectPeer(o: PeerOptions): Promise<DataPeer> {
  o.signal?.throwIfAborted();
  const debug = (message: string): void => {
    if (process.env.P2P_DEBUG === "1") console.error(`[debug ${o.selfId}] ${message}`);
  };
  const ws = o.signaling
    ? undefined
    : new WebSocket(`${toWsUrl(o.signalUrl)}?peer=${encodeURIComponent(o.selfId)}`, {
        headers: o.authorization === undefined ? {} : { authorization: o.authorization },
      });
  const pc = new PeerConnection(o.selfId, {
    iceServers: o.iceServers ?? [],
    iceTransportPolicy: o.iceTransportPolicy,
  });
  pc.onStateChange((state) => {
    debug(`onStateChange ${state}`);
    if (state === "closed" || state === "failed") {
      rejectOpen(new Error(`peer ${state}`));
      queue.end();
    }
  });
  pc.onIceStateChange((state) => debug(`onIceStateChange ${state}`));
  pc.onGatheringStateChange((state) => debug(`onGatheringStateChange ${state}`));
  pc.onSignalingStateChange((state) => debug(`onSignalingStateChange ${state}`));
  const queue = createMessageQueue();
  let channel: DataChannel | undefined;
  let channelClosed = false;
  let byeAcked = false;
  let byeReceived = false;
  let markOpen = (): void => {};
  let rejectOpen = (_error: Error): void => {};
  const open = new Promise<void>((resolve, reject) => {
    markOpen = resolve;
    rejectOpen = reject;
  });
  void open.catch(() => {});
  ws?.on("error", (error: Error) => rejectOpen(error));

  const attach = (dc: DataChannel): void => {
    channel = dc;
    dc.onMessage((msg) => {
      const control = typeof msg === "string" ? undefined : new Uint8Array(msg as ArrayBufferLike);
      if (control?.length === 1) {
        if (control[0] === BYE) {
          // SCTP is ordered and reliable: every earlier message has already been delivered.
          byeReceived = true;
          o.onCloseHandshake?.("bye-received");
          queue.end();
          if (dc.isOpen()) {
            dc.sendMessageBinary(controlFrame(BYE_ACK));
            o.onCloseHandshake?.("bye-ack-sent");
          }
          return;
        }
        if (control[0] === BYE_ACK) {
          byeAcked = true;
          o.onCloseHandshake?.("bye-ack-received");
          return;
        }
      }
      queue.push(typeof msg === "string" ? msg : msg.toString());
    });
    dc.onClosed(() => {
      channelClosed = true;
      queue.end();
      rejectOpen(new Error("channel closed"));
    });
    if (dc.isOpen()) markOpen();
    else dc.onOpen(markOpen);
  };

  const sendSignal = (payload: SignalPayload): void => {
    ws?.send(encodeFrame({ kind: "signal", from: o.selfId, to: o.remoteId, payload }));
    debug(`send ${payload.type}${payload.type === "candidate" ? ` ${payload.candidate}` : ""}`);
  };
  const outbox: SignalPayload[] = [];
  ws?.on("open", () => {
    debug("websocket open");
    for (const payload of outbox.splice(0)) sendSignal(payload);
  });
  ws?.on("close", () => debug("websocket close"));
  const signal = (payload: SignalPayload): void => {
    if (o.signaling) o.signaling.send(payload);
    else if (ws?.readyState === WebSocket.OPEN) sendSignal(payload);
    else outbox.push(payload);
  };
  pc.onLocalDescription((sdp, type) =>
    signal({ type: type === "offer" ? "offer" : "answer", sdp }),
  );
  const localCandidates: string[] = [];
  pc.onLocalCandidate((candidate, mid) => {
    localCandidates.push(candidate);
    signal({ type: "candidate", candidate, mid });
  });
  pc.onDataChannel(attach);

  const pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  let remoteDescriptionSet = false;
  const receive = (p: SignalPayload): void => {
    if (p.type === "candidate") {
      if (remoteDescriptionSet) pc.addRemoteCandidate(p.candidate, p.mid);
      else pendingCandidates.push({ candidate: p.candidate, mid: p.mid });
      return;
    }
    pc.setRemoteDescription(p.sdp, p.type);
    remoteDescriptionSet = true;
    for (const c of pendingCandidates.splice(0)) pc.addRemoteCandidate(c.candidate, c.mid);
  };
  let unlisten: (() => void) | undefined;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    o.signal?.removeEventListener("abort", close);
    rejectOpen(new Error("peer closed"));
    queue.end();
    channel?.close();
    pc.close();
    unlisten?.();
    ws?.close();
  };
  let gracefulClose: Promise<void> | undefined;
  const closeGracefully = (): Promise<void> => {
    gracefulClose ??= (async () => {
      try {
        // bufferedAmount() == 0 only means usrsctp accepted the data, not that the remote
        // received it. Ask the remote to acknowledge everything sent before BYE.
        if (!closed && channel?.isOpen() && !channelClosed) {
          channel.sendMessageBinary(controlFrame(BYE));
          o.onCloseHandshake?.("bye-sent");
          const deadline = Date.now() + (o.closeAckTimeoutMs ?? 5000);
          while (!closed && !channelClosed && !byeAcked && Date.now() < deadline) {
            await setTimeout(10);
          }
        }
      } finally {
        close();
      }
    })();
    return gracefulClose;
  };
  o.signal?.addEventListener("abort", close, { once: true });
  try {
    unlisten = o.signaling?.listen(receive);
  } catch (error) {
    close();
    throw error;
  }
  ws?.on("message", (data: RawData) => {
    try {
      const frame = decodeGatewayFrame(data.toString());
      if (frame.kind === "signal" && frame.from === o.remoteId) receive(frame.payload);
    } catch {
      ws?.close(1003, "bad frame");
    }
  });

  if (o.initiator) attach(pc.createDataChannel(CHANNEL_LABEL));
  if (ws) {
    try {
      await once(ws, "open", { signal: o.signal });
    } catch (error) {
      close();
      throw error;
    }
  }

  return {
    open,
    messages: queue.iterable,
    localCandidates,
    selectedPair: () => {
      const pair = pc.getSelectedCandidatePair();
      return pair && { local: pair.local.candidate, remote: pair.remote.candidate };
    },
    send: (text) => {
      if (byeReceived || !channel?.isOpen()) throw new Error("data channel is not open");
      channel.sendMessage(text);
    },
    close,
    closeGracefully,
  };
}
