import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import type { LocalHandler, NodeAgent } from "./node-agent.js";
import { startNodeAgent } from "./node-agent.js";
import { encodeFrame, toWsUrl } from "./protocol.js";
import { waitFor } from "./test-util.js";

const TOKEN = "test-token";

const echoHandler: LocalHandler = async (req) => ({
  status: 200,
  headers: { "content-type": "text/plain", "x-seen-path": req.path },
  body: new TextEncoder().encode(`${req.method} ${new TextDecoder().decode(req.body)}`),
});

describe("gateway and node agent", () => {
  let gateway: Gateway;
  let agent: NodeAgent | undefined;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    gateway = await startGateway({
      port: 0,
      nodeTokens: new Map([["n1", TOKEN]]),
      requestTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    await gateway.close();
    vi.restoreAllMocks();
  });

  async function connectAgent(handler: LocalHandler): Promise<void> {
    agent = startNodeAgent({
      gatewayUrl: gateway.url,
      nodeId: "n1",
      token: TOKEN,
      handler,
      reconnectMs: 50,
    });
    await waitFor(() => agent?.connected() === true);
  }

  it("answers a request through the node", async () => {
    await connectAgent(echoHandler);
    expect(gateway.connectedNodes()).toEqual(["n1"]);

    const res = await fetch(`${gateway.url}/nodes/n1/some/path?q=1`, {
      method: "POST",
      body: "hello",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("POST hello");
    expect(res.headers.get("x-seen-path")).toBe("/some/path?q=1");
  });

  it("returns 502 when the node is offline", async () => {
    const res = await fetch(`${gateway.url}/nodes/n1/anything`);
    expect(res.status).toBe(502);
  });

  it("rejects a bad token", async () => {
    const ws = new WebSocket(`${toWsUrl(gateway.url)}/agent`);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(encodeFrame({ kind: "hello", nodeId: "n1", token: "wrong" }));
    const code = await new Promise<number>((resolve) => ws.once("close", resolve));

    expect(code).toBe(4401);
    expect(gateway.connectedNodes()).toEqual([]);
  });

  it("returns 504 when the node does not answer in time", async () => {
    await connectAgent(() => new Promise(() => {}));
    const res = await fetch(`${gateway.url}/nodes/n1/slow`);
    expect(res.status).toBe(504);
  });

  it("reconnects after the gateway link drops", async () => {
    await connectAgent(echoHandler);
    await waitFor(() => gateway.connectedNodes().length === 1);
    await gateway.close();
    await waitFor(() => agent?.connected() === false);
    gateway = await startGateway({
      port: Number(new URL(gateway.url).port),
      nodeTokens: new Map([["n1", TOKEN]]),
    });
    await waitFor(() => agent?.connected() === true);
  });
});
