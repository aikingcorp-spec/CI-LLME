import { generateKeyPair } from "@rakazo/p2p-prototype/pairing";
import { expect, it, vi } from "vitest";
import { handle } from "./app.js";
import { insertNode } from "./store.js";
import { createD1, T0, testConfig } from "./test-util.js";

it.each([
  ["Runtime quota unavailable", 500],
  ["Exceeded allowed volume of requests in Durable Objects free tier.", 503],
])("records room failure %s without logging credentials or node query", async (message, status) => {
  const { d1, sql } = createD1();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await insertNode(
      d1,
      {
        nodeId: "node-one",
        user: { id: "user-one", email: "one@example.test" },
        publicKey: generateKeyPair().publicKey,
        name: "Fixture",
        kind: "linux",
        gatewayKeyId: "fixture",
      },
      T0,
    );
    const response = await handle(
      new Request("https://gateway.example.test/agent?node=node-one", {
        headers: { upgrade: "websocket", authorization: "Bearer request-secret" },
      }),
      {
        db: d1,
        config: testConfig(generateKeyPair(), {}),
        now: () => T0,
        room: () => ({
          fetch: async () => {
            throw new Error(message);
          },
          online: async () => false,
          kick: async () => {},
        }),
      },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(status === 503 ? "60" : null);
    expect(await response.text()).toBe("request failed");
    expect(error).toHaveBeenCalledWith("GATEWAY_ROUTE_ERROR", {
      route: "/agent",
      name: "Error",
      message,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("request-secret");
    expect(JSON.stringify(error.mock.calls)).not.toContain("node-one");
  } finally {
    error.mockRestore();
    sql.close();
  }
});
