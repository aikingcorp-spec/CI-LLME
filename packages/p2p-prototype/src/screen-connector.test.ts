import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createScreenConnector } from "./screen-connector.js";

it("limits socket access to sealed screen paths and injects only configured local credentials", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(wss, "listening");
  const origin = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  const connector = createScreenConnector(origin, { authorization: "Bearer fixture-local" });
  const ac = new AbortController();
  let received = 0;
  wss.on("connection", (ws, request) => {
    expect(request.headers.authorization).toBe("Bearer fixture-local");
    received++;
    ws.on("message", (bytes) => ws.send(bytes));
  });
  try {
    for (const path of [
      "/rpc/me",
      "//attacker.test/novnc/session/view/1.x/websockify",
      "/novnc/session/view/1234567890000.fixturefixturefixture/websockify?url=http://other",
      "/novnc/session/view/1234567890000.fixturefixturefixture/../websockify",
    ])
      await expect(connector(path, ac.signal)).rejects.toThrow("path");
    const socket = await connector(
      "/novnc/session/view/1234567890000.fixturefixturefixture/websockify",
      ac.signal,
    );
    const input = socket.read[Symbol.asyncIterator]();
    await socket.write(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array((await input.next()).value)).toEqual(new Uint8Array([1, 2, 3]));
    ac.abort();
    await expect(input.next()).rejects.toThrow();
    expect(received).toBe(1);
  } finally {
    ac.abort();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});
