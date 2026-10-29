import { once } from "node:events";
import type { DataChannel } from "node-datachannel";
import { PeerConnection } from "node-datachannel";
import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { SignalPayload } from "./protocol.js";
import { decodeGatewayFrame, encodeFrame, toWsUrl } from "./protocol.js";

export interface PeerOptions {
  signalUrl: string;
  selfId: string;
  remoteId: string;
  initiator: boolean;
  iceServers?: string[];
}
export interface DataPeer {
  send(text: string): void;
  messages: AsyncIterable<string>;
  open: Promise<void>;
  close(): void;
}

const CHANNEL_LABEL = "rakazo";

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
  const ws = new WebSocket(`${toWsUrl(o.signalUrl)}?peer=${encodeURIComponent(o.selfId)}`);
  const pc = new PeerConnection(o.selfId, { iceServers: o.iceServers ?? [] });
  const queue = createMessageQueue();
  let channel: DataChannel | undefined;
  let markOpen = (): void => {};
  const open = new Promise<void>((resolve) => {
    markOpen = resolve;
  });

  const attach = (dc: DataChannel): void => {
    channel = dc;
    dc.onMessage((msg) => queue.push(typeof msg === "string" ? msg : msg.toString()));
    dc.onClosed(() => queue.end());
    if (dc.isOpen()) markOpen();
    else dc.onOpen(markOpen);
  };

  const outbox: string[] = [];
  ws.on("open", () => {
    for (const frame of outbox.splice(0)) ws.send(frame);
  });
  const signal = (payload: SignalPayload): void => {
    const frame = encodeFrame({ kind: "signal", from: o.selfId, to: o.remoteId, payload });
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    else outbox.push(frame);
  };
  pc.onLocalDescription((sdp, type) =>
    signal({ type: type === "offer" ? "offer" : "answer", sdp }),
  );
  pc.onLocalCandidate((candidate, mid) => signal({ type: "candidate", candidate, mid }));
  pc.onDataChannel(attach);

  const pendingCandidates: Array<{ candidate: string; mid: string }> = [];
  let remoteDescriptionSet = false;
  ws.on("message", (data: RawData) => {
    try {
      const frame = decodeGatewayFrame(data.toString());
      if (frame.kind !== "signal") return;
      const p = frame.payload;
      if (p.type === "candidate") {
        if (remoteDescriptionSet) pc.addRemoteCandidate(p.candidate, p.mid);
        else pendingCandidates.push({ candidate: p.candidate, mid: p.mid });
        return;
      }
      pc.setRemoteDescription(p.sdp, p.type);
      remoteDescriptionSet = true;
      for (const c of pendingCandidates.splice(0)) pc.addRemoteCandidate(c.candidate, c.mid);
    } catch {
      ws.close(1003, "bad frame");
    }
  });

  if (o.initiator) attach(pc.createDataChannel(CHANNEL_LABEL));
  await once(ws, "open");

  return {
    open,
    messages: queue.iterable,
    send: (text) => {
      if (!channel?.isOpen()) throw new Error("data channel is not open");
      channel.sendMessage(text);
    },
    close: () => {
      queue.end();
      channel?.close();
      pc.close();
      ws.close();
    },
  };
}
