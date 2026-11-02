import { describe, expect, it } from "vitest";
import { createChannelFraming } from "./channel-framing.js";
import type { ChannelFrame } from "./channel-protocol.js";
import { encodeBytes } from "./channel-protocol.js";

const response = (body: string): ChannelFrame => ({
  t: "response",
  bearer: "fixture",
  id: "request",
  status: 200,
  headers: {},
  body,
});
describe("authenticated channel fragmentation", () => {
  it("keeps old small frames and requires negotiation for large ones", () => {
    const wire: string[] = [];
    const framing = createChannelFraming((raw) => wire.push(raw));
    framing.send(response("AA=="));
    expect(JSON.parse(wire[0]!)).toEqual(response("AA=="));
    expect(() => framing.send(response("A".repeat(20000)))).toThrow("support");
  });
  it("reassembles a large response exactly and bounds every SCTP message", () => {
    const wire: string[] = [];
    const sender = createChannelFraming((raw) => wire.push(raw));
    const receiver = createChannelFraming(() => {});
    sender.enable("fixture");
    receiver.enable("fixture");
    const frame = response(encodeBytes(new TextEncoder().encode("Tin nhắn 🌴".repeat(30000))));
    sender.send(frame);
    expect(wire.length).toBeGreaterThan(50);
    expect(wire.every((raw) => new TextEncoder().encode(raw).length < 65536)).toBe(true);
    const frames = wire.map((raw) => receiver.receive(raw)).filter(Boolean);
    expect(frames).toEqual([frame]);
  });
  it.each(["unauthenticated", "wrong bearer", "wrong offset", "oversized", "interrupted"])(
    "rejects %s fragments",
    (failure) => {
      const wire: string[] = [];
      const sender = createChannelFraming((raw) => wire.push(raw));
      const receiver = createChannelFraming(() => {});
      sender.enable("fixture");
      if (failure !== "unauthenticated") receiver.enable("fixture");
      sender.send(response("A".repeat(20000)));
      const f = JSON.parse(wire[0]!);
      if (failure === "wrong bearer") f.bearer = "other";
      if (failure === "wrong offset") f.offset = 1;
      if (failure === "oversized") f.total = 8 * 1024 * 1024 + 1;
      if (failure === "interrupted") {
        expect(receiver.receive(wire[0]!)).toBeUndefined();
        expect(() => receiver.receive(JSON.stringify(response("AA==")))).toThrow();
      } else expect(() => receiver.receive(JSON.stringify(f))).toThrow();
    },
  );
});
