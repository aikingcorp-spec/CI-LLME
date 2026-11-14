import { createRemoteDeviceKey, remoteDeviceSignature } from "@rakazo/auth";
import { expect, it } from "vitest";
import { handleRemoteHostRequest, remoteHostChannelResult } from "./remote-host-channel.js";

const deviceId = "device-1";
const keys = createRemoteDeviceKey();

function signed(body: string, time = Date.now()) {
  const nonce = `nonce-${time}-${body.length}`;
  return {
    body,
    headers: {
      "x-rakazo-device": deviceId,
      "x-rakazo-time": String(time),
      "x-rakazo-nonce": nonce,
      "x-rakazo-signature": remoteDeviceSignature(keys.privateKey, {
        deviceId,
        time: String(time),
        nonce,
        body,
      }),
    },
  };
}

it("accepts a signed host and keeps the connector token off a list", async () => {
  const body = JSON.stringify({ action: "list", originService: "http://127.0.0.1:3100" });
  const message = signed(body);
  const response = await handleRemoteHostRequest(
    new Request("https://identity.example.test/api/remote-host", {
      method: "POST",
      headers: message.headers,
      body: message.body,
    }),
    {
      now: () => Date.now(),
      lookup: async () => ({ accountId: "account-1", publicKey: keys.publicKey }),
      seenNonce: () => false,
      rememberNonce: () => undefined,
      act: async () => ({
        body: { portal: { kind: "unavailable", devices: [] } },
        connectorToken: "run-token-must-not-leak",
      }),
    },
  );
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("run-token-must-not-leak");
  expect(text).not.toContain("PRIVATE KEY");
  expect(
    remoteHostChannelResult({
      action: "present",
      body: { portal: { kind: "unavailable", devices: [] } },
      connectorToken: "run-token-for-host",
    }).connectorToken,
  ).toBe("run-token-for-host");
});

it("rejects a changed body, a stale time, and a repeated nonce", async () => {
  const now = Date.now();
  const body = JSON.stringify({ action: "present" });
  const message = signed(body, now);
  const seen = new Set<string>();
  const input = {
    now: () => now,
    lookup: async () => ({ accountId: "account-1", publicKey: keys.publicKey }),
    seenNonce: (nonce: string) => seen.has(nonce),
    rememberNonce: (nonce: string) => {
      seen.add(nonce);
    },
    act: async () => ({ body: { portal: { kind: "unavailable", devices: [] } } }),
  };
  const ok = await handleRemoteHostRequest(
    new Request("https://identity.example.test/api/remote-host", {
      method: "POST",
      headers: message.headers,
      body: message.body,
    }),
    input,
  );
  expect(ok.status).toBe(200);
  const replay = await handleRemoteHostRequest(
    new Request("https://identity.example.test/api/remote-host", {
      method: "POST",
      headers: message.headers,
      body: message.body,
    }),
    input,
  );
  expect(replay.status).toBe(401);
  const changed = signed(body, now);
  const rejected = await handleRemoteHostRequest(
    new Request("https://identity.example.test/api/remote-host", {
      method: "POST",
      headers: changed.headers,
      body: `${message.body} `,
    }),
    { ...input, seenNonce: () => false },
  );
  expect(rejected.status).toBe(401);
  const stale = signed(body, now - 120_000);
  const late = await handleRemoteHostRequest(
    new Request("https://identity.example.test/api/remote-host", {
      method: "POST",
      headers: stale.headers,
      body: stale.body,
    }),
    input,
  );
  expect(late.status).toBe(401);
  const revoked = await handleRemoteHostRequest(
    new Request("https://identity.example.test/api/remote-host", {
      method: "POST",
      headers: signed(JSON.stringify({ action: "list" }), now).headers,
      body: JSON.stringify({ action: "list" }),
    }),
    {
      ...input,
      lookup: async () => ({
        accountId: "account-1",
        publicKey: keys.publicKey,
        revokedAt: new Date(),
      }),
    },
  );
  expect(revoked.status).toBe(401);
});
