import { once } from "node:events";
import { PeerConnection } from "node-datachannel";
import { WebSocket } from "ws";
import type { DataPeer, PeerOptions } from "./peer-core.js";
import { connectPeer as connectCore } from "./peer-core.js";

export type {
  CloseHandshakeEvent,
  DataPeer,
  PeerChannel,
  PeerOptions,
  PeerTransport,
  PeerTransportConfig,
} from "./peer-core.js";

/** Node runtime for the shared signaling and data-channel lifecycle. */
export function connectPeer(options: PeerOptions): Promise<DataPeer> {
  return connectCore(options, {
    connection: (name, config) => new PeerConnection(name, config),
    debug: (message) => {
      if (process.env.P2P_DEBUG === "1") console.error(`[debug ${options.selfId}] ${message}`);
    },
    socket(url, authorization) {
      const ws = new WebSocket(url, {
        headers: authorization === undefined ? {} : { authorization },
      });
      return {
        ready: once(ws, "open", { signal: options.signal }).then(() => undefined),
        isOpen: () => ws.readyState === WebSocket.OPEN,
        send: (text) => ws.send(text),
        close: () => ws.close(),
        onMessage: (receive) => {
          ws.on("message", (data) => receive(data.toString()));
        },
        onClose: (receive) => {
          ws.on("close", receive);
        },
        onError: (receive) => {
          ws.on("error", receive);
        },
      };
    },
  });
}
