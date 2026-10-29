import { describe, expect, it } from "vitest";
import type { ChannelFrame } from "./channel-protocol.js";
import { decodeBytes, decodeChannelFrame, encodeBytes } from "./channel-protocol.js";

const credentials = { bearer: "node-only", id: "request" };
const request = {
  ...credentials,
  procedure: "echo",
  headers: { "content-type": "application/octet-stream" },
  body: "AP8=",
};
const frames: ChannelFrame[] = [
  { t: "hello", assertion: "signed" },
  { t: "welcome", bearer: "node-only" },
  { t: "denied" },
  { t: "call", ...request },
  { t: "subscribe", ...request },
  { t: "response", ...request, status: 200 },
  { t: "chunk", ...credentials, data: "AP8=" },
  { t: "end", ...credentials },
  { t: "cancel", ...credentials },
  { t: "error", ...credentials, message: "handler failed" },
];
describe("channel protocol", () => {
  it.each(frames)("decodes $t", (frame) => {
    const decoded = decodeChannelFrame(JSON.stringify(frame));
    // Response frames intentionally omit request-only fields.
    expect(decoded).toMatchObject(
      frame.t === "response"
        ? { t: frame.t, ...credentials, status: 200, headers: request.headers, body: request.body }
        : frame,
    );
  });
  it("preserves binary bytes", () => {
    const bytes = new Uint8Array([0, 255, 128, 1]);
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
  });
  it.each([
    "null",
    "[]",
    "broken",
    "{}",
    JSON.stringify({ t: "call", ...request, bearer: undefined }),
    JSON.stringify({ t: "call", ...request, headers: { bad: 2 } }),
    JSON.stringify({ t: "call", ...request, body: "not-base64" }),
    JSON.stringify({ t: "chunk", ...credentials, data: "AA" }),
    JSON.stringify({ t: "response", ...request, status: 99 }),
    JSON.stringify({ t: "response", ...request, status: 200.5 }),
    JSON.stringify({ t: "error", ...credentials }),
  ])("rejects malformed input %s", (raw) => {
    expect(() => decodeChannelFrame(raw)).toThrow();
  });
});
