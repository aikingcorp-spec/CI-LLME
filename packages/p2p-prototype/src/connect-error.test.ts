import { describe, expect, it } from "vitest";
import { DataChannelClientTransport } from "./client-transport.js";
import { P2PConnectError } from "./connect-error.js";
import type { PeerChannel, PeerTransport } from "./webrtc-peer.js";

const USER_MESSAGE =
  "Không kết nối được tới máy của bạn. Mạng này có thể đang chặn UDP, hãy thử mạng khác.";

/** A PeerTransport whose channel never opens; `fire` drives the connection state. */
function stuckTransport() {
  let onState: (state: string) => void = () => {};
  const channel: PeerChannel = {
    onMessage: () => {},
    onClosed: () => {},
    onOpen: () => {},
    isOpen: () => false,
    sendMessage: () => false,
    sendMessageBinary: () => false,
    close: () => {},
  };
  const pc: PeerTransport = {
    onStateChange: (cb) => {
      onState = cb;
    },
    onIceStateChange: () => {},
    onGatheringStateChange: () => {},
    onSignalingStateChange: () => {},
    onLocalDescription: () => {},
    onLocalCandidate: () => {},
    onDataChannel: () => {},
    setRemoteDescription: () => {},
    addRemoteCandidate: () => {},
    createDataChannel: () => channel,
    getSelectedCandidatePair: () => null,
    close: () => {},
  };
  return { pc, fire: (state: string) => onState(state) };
}

const connect = (
  transport: ReturnType<typeof stuckTransport>,
  extra: { connectTimeoutMs?: number } = {},
) =>
  DataChannelClientTransport.connect({
    signalUrl: "",
    signaling: { send: () => {}, listen: () => () => {} },
    selfId: "a",
    remoteId: "b",
    initiator: true,
    assertion: "unused",
    createPeerConnection: () => transport.pc,
    ...extra,
  });

describe("P2PConnectError", () => {
  it.each([
    ["failed", "ice_failed"],
    ["closed", "no_candidate_pair"],
  ] as const)("rejects with %s state as %s", async (state, code) => {
    const transport = stuckTransport();
    const attempt = connect(transport);
    setTimeout(() => transport.fire(state), 10);
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(P2PConnectError);
    expect(error).toMatchObject({ code, userMessage: USER_MESSAGE });
  });

  it("rejects with a timeout when the channel does not open in time", async () => {
    const error = await connect(stuckTransport(), { connectTimeoutMs: 30 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(P2PConnectError);
    expect(error).toMatchObject({ code: "timeout", userMessage: USER_MESSAGE });
  });
});
