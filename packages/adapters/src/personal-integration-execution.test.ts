import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { createDb } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { PersonalIntegrationSettings } from "./personal-integration-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

const { prisma, pool } = createDb("postgres://offline:offline@127.0.0.1:9/offline", {
  encryptContent: false,
});
afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

const alice: AdapterContext = {
  userId: "alice",
  spaceId: "space",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};

function provider(apiKey: string, seen: string[]): ManagedConnectorProvider {
  return {
    describe: () => ({
      id: "composio",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    }),
    discoverTools: async () => [],
    catalog: async () => [],
    listConnectedExternalIds: async () => [],
    connectionReady: async () => false,
    begin: async (request) => {
      seen.push(`begin:${apiKey}:${request.redirectUrl}`);
      return { authorizationUrl: "https://idp.example/authorize", state: "state-1" };
    },
    complete: async () => ({ connectionRef: "state-1" }),
    revoke: async () => {},
    execute: async function* () {
      seen.push(`execute:${apiKey}`);
      yield { type: "result", data: { ok: true } };
    },
  } as ManagedConnectorProvider;
}

describe("personal integration execution", () => {
  it("uses the owner's key for OAuth and tools, then fails closed after revoke", async () => {
    const rows = new Map<string, { ciphertext: string; revision: string }>();
    const key = (where: { userId_provider: { userId: string; provider: string } }) =>
      JSON.stringify(where.userId_provider);
    vi.spyOn(prisma.userIntegrationProviderConfig, "findUnique").mockImplementation(
      vi.fn().mockImplementation(async ({ where }) => rows.get(key(where)) ?? null),
    );
    vi.spyOn(prisma.userIntegrationProviderConfig, "upsert").mockImplementation(
      vi.fn().mockImplementation(async ({ where, create, update }) => {
        const row = {
          ciphertext: create.ciphertext,
          revision: rows.has(key(where)) ? update.revision : create.revision,
        };
        rows.set(key(where), row);
        return row;
      }),
    );
    vi.spyOn(prisma.userIntegrationProviderConfig, "deleteMany").mockImplementation(
      vi.fn().mockImplementation(async ({ where }) => {
        rows.delete(JSON.stringify({ userId: where.userId, provider: where.provider }));
        return { count: 1 };
      }),
    );
    const seen: string[] = [];
    const fallback: string[] = [];
    const personal = new PersonalIntegrationSettings(
      prisma,
      new EncryptedSecretStore("offline-test-key"),
      (config) => {
        if (config.provider !== "composio") throw new Error("Unexpected provider");
        return provider(config.apiKey, seen);
      },
    );
    const settings = new IntegrationProviderSettings(
      prisma,
      new EncryptedSecretStore("offline-test-key"),
      "identity",
      { composio: provider("deployment-key", fallback) },
      undefined,
      personal,
    );
    await personal.save({ provider: "composio", apiKey: "user-owned-key" }, alice);
    const connector = settings.providers().find((item) => item.describe().id === "composio");
    if (!connector) throw new Error("Missing connector");
    const redirect = "https://h.example.test/integrations/callback";
    await connector.begin({ provider: "gmail", redirectUrl: redirect }, alice);
    const events = [];
    for await (const event of connector.execute(
      { tool: "example", args: {}, executionId: "call" },
      alice,
    )) {
      events.push(event);
    }
    expect(seen).toEqual([`begin:user-owned-key:${redirect}`, "execute:user-owned-key"]);
    expect(events).toEqual([{ type: "result", data: { ok: true } }]);
    expect(fallback).toEqual([]);
    const refused = async (userId: string) => {
      for await (const _event of connector.execute(
        { tool: "example", args: {}, executionId: "call" },
        { ...alice, userId },
      )) {
        throw new Error("A revoked or foreign key must not run");
      }
    };
    await expect(refused("bob")).rejects.toThrow(
      "Set up an integration provider in Integrations first",
    );
    expect(fallback).toEqual([]);
    await settings.revokePersonal("alice");
    await expect(refused("alice")).rejects.toThrow(
      "Set up an integration provider in Integrations first",
    );
    expect(JSON.stringify(seen)).not.toContain("deployment-key");
    expect(fallback).toEqual([]);
    expect(rows.size).toBe(0);
  });
});
