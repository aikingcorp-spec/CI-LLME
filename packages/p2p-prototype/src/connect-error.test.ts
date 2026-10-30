import { describe, expect, it } from "vitest";
import { DataChannelClientTransport } from "./client-transport.js";
import { P2PConnectError, p2pConnectMessage } from "./connect-error.js";
import type { SignalPayload } from "./protocol.js";
import type { PeerChannel, PeerTransport } from "./webrtc-peer.js";

const NOT_REACHED_VI =
  "Không kết nối được tới máy của bạn. Kiểm tra máy đang bật, hoặc thử mạng khác (4G hoặc wifi nhà).";
const NOT_REACHED_EN =
  "Could not connect to your computer. Check that it is turned on, or try another network (4G or home wifi).";
const BLOCKED_VI =
  "Mạng của bạn đang chặn kết nối trực tiếp, hãy thử mạng khác (4G hoặc wifi nhà).";
const BLOCKED_EN =
  "Your network is blocking direct connections, try another network (4G or home wifi).";

/** A PeerTransport whose channel never opens; the test drives state and candidates. */
function stuckTransport() {
  let onState: (state: string) => void = () => {};
  let onCandidate: (candidate: string, mid: string) => void = () => {};
  let receive: (payload: SignalPayload) => void = () => {};
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
    onLocalCandidate: (cb) => {
      onCandidate = cb;
    },
    onDataChannel: () => {},
    setRemoteDescription: () => {},
    addRemoteCandidate: () => {},
    createDataChannel: () => channel,
    getSelectedCandidatePair: () => null,
    close: () => {},
  };
  return {
    pc,
    fire: (state: string) => onState(state),
    localCandidate: () => onCandidate("candidate:1 1 UDP 2114977791 192.0.2.1 50000 typ host", "0"),
    remoteCandidate: () =>
      receive({
        type: "candidate",
        candidate: "candidate:2 1 UDP 2114977791 192.0.2.2 50001 typ host",
        mid: "0",
      }),
    signaling: {
      send: () => {},
      listen: (listener: (payload: SignalPayload) => void) => {
        receive = listener;
        return () => {};
      },
    },
  };
}

const connect = (
  transport: ReturnType<typeof stuckTransport>,
  extra: { connectTimeoutMs?: number } = {},
) =>
  DataChannelClientTransport.connect({
    signalUrl: "",
    signaling: transport.signaling,
    selfId: "a",
    remoteId: "b",
    initiator: true,
    assertion: "unused",
    createPeerConnection: () => transport.pc,
    ...extra,
  });

async function failWith(
  prepare: (transport: ReturnType<typeof stuckTransport>) => void,
  state: string,
) {
  const transport = stuckTransport();
  const attempt = connect(transport);
  setTimeout(() => {
    prepare(transport);
    transport.fire(state);
  }, 10);
  return attempt.catch((e: unknown) => e);
}

describe("P2PConnectError messages", () => {
  it.each([
    ["ice_failed", BLOCKED_VI, BLOCKED_EN],
    ["no_candidate_pair", NOT_REACHED_VI, NOT_REACHED_EN],
    ["timeout", NOT_REACHED_VI, NOT_REACHED_EN],
  ] as const)("%s carries its own Vietnamese and English text", (code, vi, en) => {
    const error = new P2PConnectError(code, "x");
    expect(error.userMessage).toBe(vi);
    expect(error.userMessageEn).toBe(en);
    expect(p2pConnectMessage(code)).toEqual({ vi, en });
  });
});

describe("P2PConnectError from a stuck connection", () => {
  it("is ice_failed when ICE fails with candidates on both sides", async () => {
    const error = await failWith((t) => {
      t.localCandidate();
      t.remoteCandidate();
    }, "failed");
    expect(error).toBeInstanceOf(P2PConnectError);
    expect(error).toMatchObject({
      code: "ice_failed",
      userMessage: BLOCKED_VI,
      userMessageEn: BLOCKED_EN,
    });
  });

  it.each([
    ["no candidates at all", () => {}],
    ["only local candidates", (t: ReturnType<typeof stuckTransport>) => t.localCandidate()],
    ["only remote candidates", (t: ReturnType<typeof stuckTransport>) => t.remoteCandidate()],
  ] as const)("is no_candidate_pair when ICE fails with %s", async (_name, prepare) => {
    const error = await failWith(prepare, "failed");
    expect(error).toBeInstanceOf(P2PConnectError);
    expect(error).toMatchObject({
      code: "no_candidate_pair",
      userMessage: NOT_REACHED_VI,
      userMessageEn: NOT_REACHED_EN,
    });
  });

  it("is no_candidate_pair when the connection closes before it opens", async () => {
    const error = await failWith(() => {}, "closed");
    expect(error).toBeInstanceOf(P2PConnectError);
    expect(error).toMatchObject({ code: "no_candidate_pair", userMessage: NOT_REACHED_VI });
  });

  it("is timeout when the channel does not open in time", async () => {
    const error = await connect(stuckTransport(), { connectTimeoutMs: 30 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(P2PConnectError);
    expect(error).toMatchObject({
      code: "timeout",
      userMessage: NOT_REACHED_VI,
      userMessageEn: NOT_REACHED_EN,
    });
  });
});
