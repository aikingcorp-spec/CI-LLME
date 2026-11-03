// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeVoice } from "./native-voice";

const track = { enabled: true, stop: vi.fn() };
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
let pc: {
  connectionState: string;
  onconnectionstatechange?: () => void;
  close: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
};
let channel: {
  readyState: string;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};
let media: ReturnType<typeof vi.fn>;
const sessions: NativeVoice[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  track.enabled = true;
  media = vi.fn(async () => stream);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: media } });
  vi.stubGlobal(
    "Audio",
    class {
      autoplay = false;
      srcObject = null;
      pause = vi.fn();
      play = vi.fn(async () => undefined);
    },
  );
  vi.stubGlobal(
    "RTCPeerConnection",
    class {
      connectionState = "new";
      close = vi.fn();
      setRemoteDescription = vi.fn();
      localDescription = { sdp: "v=0\r\nfixture-offer" };
      createOffer = vi.fn(async () => this.localDescription);
      setLocalDescription = vi.fn();
      addTrack = vi.fn();
      constructor() {
        pc = this;
      }
      createDataChannel() {
        channel = { readyState: "open", close: vi.fn(), send: vi.fn() };
        return channel;
      }
    },
  );
});
afterEach(() => {
  for (const voice of sessions.splice(0)) voice.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  const hooks = {
    connect: vi.fn(async () => "v=0\r\nfixture-answer"),
    ready: vi.fn(),
    transcript: vi.fn(),
    delegate: vi.fn(async () => undefined),
    error: vi.fn(),
  };
  const voice = new NativeVoice(hooks);
  sessions.push(voice);
  const receive = (value: unknown) => channel.onmessage?.({ data: JSON.stringify(value) });
  return { voice, hooks, receive };
}
it("connects media, delegates once per provider ID, chunks UTF-8 results and releases the microphone", async () => {
  const f = fixture();
  await f.voice.start();
  expect(f.hooks.connect).toHaveBeenCalledWith("v=0\r\nfixture-offer", expect.any(AbortSignal));
  expect(pc.setRemoteDescription).toHaveBeenCalledWith({
    type: "answer",
    sdp: "v=0\r\nfixture-answer",
  });
  f.receive({ type: "session.started" });
  expect(f.hooks.ready).toHaveBeenCalledOnce();
  const request = {
    type: "delegation.created",
    item: {
      id: "intent-1",
      type: "delegation",
      target: "client",
      content: [{ type: "input_text", text: "Create two teammates" }],
    },
  };
  f.receive(request);
  f.receive(request);
  expect(f.hooks.delegate).toHaveBeenCalledExactlyOnceWith("intent-1", "Create two teammates");
  const text = "Kết quả 🥔 ".repeat(100);
  f.voice.reply("intent-1", text);
  const packets = channel.send.mock.calls.map(([payload]) => JSON.parse(payload));
  expect(packets.map((packet) => packet.content[0].text).join("")).toBe(text);
  expect(
    packets.every((packet) => new TextEncoder().encode(packet.content[0].text).byteLength <= 500),
  ).toBe(true);
  f.voice.mute(true);
  expect(track.enabled).toBe(false);
  f.voice.close();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(pc.close).toHaveBeenCalledOnce();
});
it("stops a late microphone permission result after hang-up without contacting the provider", async () => {
  let resolve: (value: typeof stream) => void = () => undefined;
  media.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const f = fixture();
  const pending = f.voice.start();
  f.voice.close();
  resolve(stream);
  await pending;
  expect(track.stop).toHaveBeenCalledOnce();
  expect(f.hooks.connect).not.toHaveBeenCalled();
});
it("times out an open transport that never receives session.started", async () => {
  const f = fixture();
  await f.voice.start();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(f.hooks.error).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
});
it("allows a transient media disconnect to recover within the fixed deadline", async () => {
  const f = fixture();
  await f.voice.start();
  f.receive({ type: "session.started" });
  pc.connectionState = "disconnected";
  pc.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(5000);
  pc.connectionState = "connected";
  pc.onconnectionstatechange?.();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.hooks.error).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
});
it("closes media on an SDP request failure without a second call attempt", async () => {
  const f = fixture();
  f.hooks.connect.mockRejectedValueOnce(new Error("Authorization rejected"));
  await f.voice.start();
  expect(f.hooks.error).toHaveBeenCalledExactlyOnceWith("Authorization rejected");
  expect(track.stop).toHaveBeenCalledOnce();
  expect(f.hooks.connect).toHaveBeenCalledOnce();
});
