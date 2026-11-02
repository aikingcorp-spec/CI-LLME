import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { startNodeAgent } from "./node-agent.js";
import { generateKeyPair, nodeProofMessage, verify } from "./pairing.js";
import { decodeNodeFrame, encodeFrame } from "./protocol.js";

it("recovers from a refused upgrade and a deliberate transport drop with signed hello on each connection", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  const key = generateKeyPair();
  const states: string[] = [];
  const failures: unknown[] = [];
  let upgrades = 0;
  let authenticated = 0;
  let latest: WebSocket | undefined;
  server.on("upgrade", (request, socket, head) => {
    if (++upgrades === 1) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      latest = ws;
      ws.once("message", (raw) => {
        const frame = decodeNodeFrame(raw.toString());
        if (
          frame.kind !== "hello" ||
          !verify(key.publicKey, nodeProofMessage("agent", frame.nodeId, frame.ts), frame.sig)
        ) {
          ws.close(4401, "unauthorized");
          return;
        }
        authenticated++;
        ws.send(encodeFrame({ kind: "welcome", nodeId: frame.nodeId }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  const agent = startNodeAgent({
    gatewayUrl: `http://127.0.0.1:${address.port}`,
    nodeId: "fixture-node",
    keyPair: key,
    handler: async () => ({ status: 404, headers: {}, body: new Uint8Array() }),
    onGatewayState: (state) => states.push(state),
    onGatewayError: (failure) => failures.push(failure),
  });
  try {
    await expect.poll(() => agent.connected(), { timeout: 4000 }).toBe(true);
    expect(failures).toContainEqual({ kind: "handshake", status: 503 });
    expect(authenticated).toBe(1);
    latest?.terminate();
    await expect.poll(() => authenticated, { timeout: 3000 }).toBe(2);
    await expect.poll(() => agent.connected()).toBe(true);
    expect(states.filter((state) => state === "connected")).toHaveLength(2);
    expect(upgrades).toBe(3);
  } finally {
    await agent.close();
    sockets.close();
    server.close();
    await once(server, "close");
  }
});
