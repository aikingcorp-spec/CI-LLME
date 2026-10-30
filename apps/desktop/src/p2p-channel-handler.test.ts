import { describe, expect, it, vi } from "vitest";
import { desktopChannelHandler } from "./p2p-channel-handler.js";

describe("desktopChannelHandler", () => {
  const rpc = () => ({
    call: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array([1]) })),
    subscribe: vi.fn(async function* () {
      yield new Uint8Array([2]);
    }),
  });

  it("answers health from GET /health and forwards everything else to rpc", async () => {
    const forward = rpc();
    const request = vi.fn(async () => new Response("ok", { status: 200 }));
    const handler = desktopChannelHandler("http://127.0.0.1:4000", forward, request);
    const health = await handler.call("health", {}, new Uint8Array());
    expect(new TextDecoder().decode(health.body)).toBe("ok");
    expect(request).toHaveBeenCalledWith(new URL("http://127.0.0.1:4000/health"), {
      method: "GET",
    });
    expect(forward.call).not.toHaveBeenCalled();
    await handler.call("threads/list", {}, new Uint8Array());
    expect(forward.call).toHaveBeenCalledWith("threads/list", {}, new Uint8Array());
    for await (const _ of handler.subscribe(
      "x",
      {},
      new Uint8Array(),
      new AbortController().signal,
    ));
    expect(forward.subscribe).toHaveBeenCalledTimes(1);
  });
});
