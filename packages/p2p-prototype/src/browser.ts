/// <reference lib="dom" />
import type { PeerChannel, PeerOptions, PeerTransport, PeerTransportConfig } from "./peer-core.js";
import { connectPeer } from "./peer-core.js";
import { ASSERTION_SUBPROTOCOL_PREFIX, SIGNAL_SUBPROTOCOL } from "./protocol.js";

export type { ClientCall, ClientResponse, ClientTransport } from "./data-channel-client.js";
export { DataChannelClientTransport } from "./data-channel-client.js";
export type { Session } from "./gateway-http-client.js";
export {
  fetchTurnCredentials,
  listNodes,
  openSession,
  startPairing,
} from "./gateway-http-client.js";
export type { DataPeer } from "./peer-core.js";
export type { PairedNode } from "./protocol.js";

function channel(dc: RTCDataChannel): PeerChannel {
  dc.binaryType = "arraybuffer";
  return {
    onMessage: (receive) => dc.addEventListener("message", (event) => receive(event.data)),
    onClosed: (receive) => dc.addEventListener("close", receive),
    onOpen: (receive) => dc.addEventListener("open", receive),
    isOpen: () => dc.readyState === "open",
    sendMessage: (text) => {
      dc.send(text);
      return true;
    },
    sendMessageBinary: (bytes) => {
      dc.send(new Uint8Array(bytes));
      return true;
    },
    close: () => dc.close(),
  };
}

/** Only the native RTC API translation lives here; signaling/lifecycle stay in peer-core. */
export function browserConnection(config: RTCConfiguration): PeerTransport {
  const pc = new RTCPeerConnection(config);
  let state: (value: string) => void = () => {};
  let description: (sdp: string, type: string) => void = () => {};
  let operations = Promise.resolve();
  const run = (operation: () => Promise<void>) => {
    operations = operations.then(operation).catch(() => state("failed"));
  };
  return {
    onStateChange(receive) {
      state = receive;
      pc.addEventListener("connectionstatechange", () =>
        receive(pc.connectionState === "disconnected" ? "failed" : pc.connectionState),
      );
    },
    onIceStateChange: (receive) =>
      pc.addEventListener("iceconnectionstatechange", () => receive(pc.iceConnectionState)),
    onGatheringStateChange: (receive) =>
      pc.addEventListener("icegatheringstatechange", () => receive(pc.iceGatheringState)),
    onSignalingStateChange: (receive) =>
      pc.addEventListener("signalingstatechange", () => receive(pc.signalingState)),
    onLocalDescription(receive) {
      description = receive;
    },
    onLocalCandidate: (receive) =>
      pc.addEventListener("icecandidate", ({ candidate }) => {
        if (candidate) receive(candidate.candidate, candidate.sdpMid ?? "0");
      }),
    onDataChannel: (receive) =>
      pc.addEventListener("datachannel", ({ channel: dc }) => receive(channel(dc))),
    setRemoteDescription(sdp, type) {
      run(async () => {
        await pc.setRemoteDescription({ sdp, type });
        if (type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          description(answer.sdp ?? "", "answer");
        }
      });
    },
    addRemoteCandidate(candidate, mid) {
      run(async () => {
        await pc.addIceCandidate({ candidate, sdpMid: mid });
      });
    },
    createDataChannel(label) {
      const dc = pc.createDataChannel(label);
      run(async () => {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        description(offer.sdp ?? "", "offer");
      });
      return channel(dc);
    },
    getSelectedCandidatePair: () => null,
    close: () => pc.close(),
  };
}

export type BrowserPeerOptions = Omit<
  PeerOptions,
  "iceServers" | "createPeerConnection" | "authorization"
> & {
  assertion: string;
  iceServers?: RTCIceServer[];
};

export function connectBrowserPeer(options: BrowserPeerOptions) {
  return connectPeer(
    { ...options, iceServers: [] },
    {
      connection: (_name: string, _config: PeerTransportConfig) =>
        browserConnection({
          iceServers: options.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
          iceTransportPolicy: options.iceTransportPolicy,
        }),
      socket(url) {
        const ws = new WebSocket(url, [
          SIGNAL_SUBPROTOCOL,
          `${ASSERTION_SUBPROTOCOL_PREFIX}${options.assertion}`,
        ]);
        const ready = new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error("signaling failed")), { once: true });
          ws.addEventListener("close", () => reject(new Error("signaling closed")), { once: true });
        });
        // Abort also covers a stalled WebSocket upgrade, before peer-core can return a peer.
        const abort = () => ws.close();
        options.signal?.addEventListener("abort", abort, { once: true });
        ws.addEventListener("close", () => options.signal?.removeEventListener("abort", abort), {
          once: true,
        });
        return {
          ready,
          isOpen: () => ws.readyState === WebSocket.OPEN,
          send: (text) => ws.send(text),
          close: () => ws.close(),
          onMessage: (receive) => ws.addEventListener("message", ({ data }) => receive(data)),
          onClose: (receive) => ws.addEventListener("close", receive),
          onError: (receive) =>
            ws.addEventListener("error", () => receive(new Error("signaling failed"))),
        };
      },
    },
  );
}
