import { createRemoteDeviceKey } from "@rakazo/auth";
import { expect, it } from "vitest";
import { createRemoteRegistryClient } from "./remote-registry-client.js";

it("signs the host call and does not send the private key", async () => {
  const keys = createRemoteDeviceKey();
  let captured = "";
  const client = createRemoteRegistryClient({
    origin: "https://identity.example.test",
    deviceId: "device-1",
    privateKey: keys.privateKey,
    originService: "http://127.0.0.1:3100",
    now: () => 1_700_000_000_000,
    fetch: async (_url, init) => {
      captured = String(init?.body);
      return new Response(
        JSON.stringify({
          portal: { kind: "open", deviceId: "device-1", logicalHost: "h", devices: [] },
          connectorToken: "run-token",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const result = await client.present();
  expect(captured).toContain('"action":"present"');
  expect(captured).toContain("http://127.0.0.1:3100");
  expect(captured).not.toContain(keys.privateKey);
  expect(captured).not.toContain("PRIVATE KEY");
  expect(result.connectorToken).toBe("run-token");
  expect(JSON.stringify(result.portal)).not.toContain("run-token");
});

it("leaves a connector token out of a list", async () => {
  const keys = createRemoteDeviceKey();
  const client = createRemoteRegistryClient({
    origin: "https://identity.example.test",
    deviceId: "device-1",
    privateKey: keys.privateKey,
    originService: "http://127.0.0.1:3100",
    fetch: async () =>
      new Response(JSON.stringify({ portal: { kind: "unavailable", devices: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const result = await client.list();
  expect(result.connectorToken).toBeUndefined();
  expect(result.portal.kind).toBe("unavailable");
});

it.each([
  { portal: { kind: "unavailable", devices: "invalid" }, connectorToken: "must-not-adopt" },
  {
    portal: { kind: "unavailable", devices: [] },
    kind: "invalid-command",
    connectorToken: "must-not-adopt",
  },
  { portal: { kind: "unavailable", devices: [] }, holders: [123] },
])(
  "rejects malformed registry responses before returning a connector token: %j",
  async (payload) => {
    const keys = createRemoteDeviceKey();
    const client = createRemoteRegistryClient({
      origin: "https://identity.example.test",
      deviceId: "device-1",
      privateKey: keys.privateKey,
      originService: "http://127.0.0.1:3100",
      fetch: async () => Response.json(payload),
    });
    await expect(client.present()).rejects.toThrow();
  },
);
