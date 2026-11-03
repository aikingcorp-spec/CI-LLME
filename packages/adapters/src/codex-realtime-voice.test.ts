import { expect, it, vi } from "vitest";
import { createCodexRealtimeCall } from "./codex-realtime-voice.js";

const input = {
  accessToken: "fake-private-access",
  accountId: "fake-account",
  offer: "v=0\r\n",
  voice: "cove",
  instructions: "Use Pi for tools.",
  signal: new AbortController().signal,
};
it("uses the native OAuth call path and returns only the SDP answer", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("v=0\r\nanswer", { status: 201 }));
  expect(await createCodexRealtimeCall(input, request)).toBe("v=0\r\nanswer");
  const [url, options] = request.mock.calls[0]!;
  expect(String(url)).toBe(
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
  );
  expect(options?.headers).toMatchObject({
    authorization: "Bearer fake-private-access",
    "ChatGPT-Account-ID": "fake-account",
  });
  const body = JSON.parse(String(options?.body));
  expect(body.session.delegation).toEqual({ type: "client", ack_filler: false });
  expect(body.session).not.toHaveProperty("model");
  expect(JSON.stringify(body)).not.toContain(input.accessToken);
});
it("does not disclose provider errors", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("private upstream details", { status: 403 }));
  await expect(createCodexRealtimeCall(input, request)).rejects.toThrow(
    "authorization was rejected",
  );
});
it("rejects unsupported voices before making a request", async () => {
  const request = vi.fn<typeof fetch>();
  await expect(
    createCodexRealtimeCall({ ...input, voice: "not-a-voice" }, request),
  ).rejects.toThrow("not supported");
  expect(request).not.toHaveBeenCalled();
});
it("bounds untrusted SDP answers", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(`v=0${"a".repeat(128 * 1024)}`));
  await expect(createCodexRealtimeCall(input, request)).rejects.toThrow("too large");
});
