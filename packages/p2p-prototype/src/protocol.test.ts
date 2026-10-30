import { describe, expect, it } from "vitest";
import type { GatewayFrame, NodeFrame } from "./protocol.js";
import { decodeGatewayFrame, decodeNodeFrame, encodeFrame, toWsUrl } from "./protocol.js";

describe("protocol", () => {
  it("round-trips node frames", () => {
    const frames: NodeFrame[] = [
      { kind: "hello", nodeId: "n1", ts: 1_700_000_000_000, sig: "s" },
      { kind: "response", id: "1", status: 200, headers: { a: "b" }, body: "aGk=" },
      { kind: "signal", from: "a", to: "b", payload: { type: "offer", sdp: "v=0" } },
    ];
    for (const frame of frames) expect(decodeNodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips gateway frames", () => {
    const frames: GatewayFrame[] = [
      { kind: "welcome", nodeId: "n1" },
      { kind: "request", id: "1", method: "GET", path: "/x?y=1", headers: {}, body: "" },
      {
        kind: "signal",
        from: "a",
        to: "b",
        payload: { type: "candidate", candidate: "c", mid: "0" },
      },
    ];
    for (const frame of frames) expect(decodeGatewayFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("throws on a bad frame", () => {
    expect(() => decodeNodeFrame("not json")).toThrow();
    expect(() => decodeNodeFrame(JSON.stringify({ kind: "hello", nodeId: "n1" }))).toThrow();
    const badTs = { kind: "hello", nodeId: "n1", ts: "1", sig: "s" };
    expect(() => decodeNodeFrame(JSON.stringify(badTs))).toThrow();
    const badStatus = { kind: "response", id: "1", status: "200", headers: {}, body: "" };
    const badPayload = { kind: "signal", from: "a", to: "b", payload: { type: "x" } };
    expect(() => decodeNodeFrame(JSON.stringify(badStatus))).toThrow();
    expect(() => decodeNodeFrame(JSON.stringify(badPayload))).toThrow();
    expect(() => decodeNodeFrame(encodeFrame({ kind: "welcome", nodeId: "n1" }))).toThrow();
    const hello = encodeFrame({ kind: "hello", nodeId: "n1", ts: 1, sig: "s" });
    expect(() => decodeGatewayFrame(hello)).toThrow();
  });
});

describe("toWsUrl", () => {
  it.each([
    ["https://test.vnbot.run", "wss://test.vnbot.run"],
    ["https://test.vnbot.run/signal", "wss://test.vnbot.run/signal"],
    ["HTTPS://test.vnbot.run:8443/agent", "wss://test.vnbot.run:8443/agent"],
    ["http://127.0.0.1:8787/signal", "ws://127.0.0.1:8787/signal"],
    ["wss://test.vnbot.run/signal", "wss://test.vnbot.run/signal"],
    ["ws://127.0.0.1:8787", "ws://127.0.0.1:8787"],
  ])("maps %s to %s", (input, expected) => {
    expect(toWsUrl(input)).toBe(expected);
  });

  it("never downgrades an https gateway to ws", () => {
    expect(toWsUrl("https://test.vnbot.run")).not.toMatch(/^ws:/);
  });

  it.each(["test.vnbot.run", "ftp://test.vnbot.run", "httpx://test.vnbot.run", ""])(
    "rejects %j",
    (input) => {
      expect(() => toWsUrl(input)).toThrow("gateway URL must start with");
    },
  );
});
