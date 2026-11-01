import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { forwardChannelHandler } from "./node-channel-server.js";

it("binds real HTTP RPC to local credentials and rejects path traversal and credential leakage", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    expect(request.headers.cookie).toBe("local-session=fixture");
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.origin).toBeUndefined();
    expect(request.headers["x-forwarded-host"]).toBeUndefined();
    expect(request.headers["x-rakazo-local-settings-token"]).toBeUndefined();
    response
      .writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "private-local-cookie=fixture",
      })
      .end('{"json":{"ok":true}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handler = forwardChannelHandler(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    { cookie: "local-session=fixture" },
  );
  try {
    const reply = await handler.call(
      "me",
      {
        cookie: "attacker=wrong",
        authorization: "Bearer wrong",
        origin: "https://untrusted.example.test",
        "x-forwarded-host": "untrusted.example.test",
        "x-rakazo-local-settings-token": "wrong",
      },
      new Uint8Array(),
    );
    expect(reply.status).toBe(200);
    expect(reply.headers["set-cookie"]).toBeUndefined();
    for (const procedure of [
      "../api/auth/get-session",
      "a/../../api/auth/sign-out",
      "/api/auth/get-session",
      "me?admin=true",
    ])
      await expect(handler.call(procedure, {}, new Uint8Array())).rejects.toThrow(
        "Invalid RPC procedure",
      );
    expect(requests).toEqual(["/rpc/me"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
