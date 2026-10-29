import { describe, expect, it } from "vitest";
import type { GatewayFrame, NodeFrame } from "./protocol.js";
import { decodeGatewayFrame, decodeNodeFrame, encodeFrame } from "./protocol.js";

describe("protocol", () => {
  it("round-trips node frames", () => {
    const frames: NodeFrame[] = [
      { kind: "hello", nodeId: "n1", token: "t" },
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
    const badStatus = { kind: "response", id: "1", status: "200", headers: {}, body: "" };
    const badPayload = { kind: "signal", from: "a", to: "b", payload: { type: "x" } };
    expect(() => decodeNodeFrame(JSON.stringify(badStatus))).toThrow();
    expect(() => decodeNodeFrame(JSON.stringify(badPayload))).toThrow();
    expect(() => decodeNodeFrame(encodeFrame({ kind: "welcome", nodeId: "n1" }))).toThrow();
    const hello = encodeFrame({ kind: "hello", nodeId: "n1", token: "t" });
    expect(() => decodeGatewayFrame(hello)).toThrow();
  });
});
