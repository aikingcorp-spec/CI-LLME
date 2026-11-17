import type { AdapterContext } from "@rakazo/adapter-kit";
import type { IntegrationProviderConfig } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ComposioConnector } from "./providers/integration/composio/composio-connector.js";
import {
  IntegrationProviderSettings,
  prepareManagedConnectorForTransaction,
} from "./integration-provider-settings.js";
import { PersonalIntegrationSettings } from "./personal-integration-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

const { prisma, pool } = createDb("postgres://offline:offline@127.0.0.1:9/offline", {
  encryptContent: false,
});
afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});
const context: AdapterContext = {
  userId: "alice",
  spaceId: "space",
  operationId: "test",
  traceId: "test",
  signal: new AbortController().signal,
};

function fixture() {
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
  vi.spyOn(prisma.userIntegrationProviderConfig, "create").mockImplementation(
    vi.fn().mockImplementation(async ({ data }) => {
      const id = key({ userId_provider: { userId: data.userId, provider: data.provider } });
      if (rows.has(id)) throw new Error("Duplicate fixture integration");
      const row = { ciphertext: data.ciphertext, revision: data.revision };
      rows.set(id, row);
      return row;
    }),
  );
  vi.spyOn(prisma.userIntegrationProviderConfig, "deleteMany").mockImplementation(
    vi.fn().mockImplementation(async ({ where }) => {
      rows.delete(JSON.stringify({ userId: where.userId, provider: where.provider }));
      return { count: 1 };
    }),
  );
  const verify = vi.fn(async () => []);
  const create = vi.fn((config: IntegrationProviderConfig) => {
    if (config.provider !== "composio") throw new Error("Unexpected fixture provider");
    const adapter = new ComposioConnector({ apiKey: config.apiKey });
    vi.spyOn(adapter, "listConnectedExternalIds").mockImplementation(verify);
    return adapter;
  });
  return {
    rows,
    verify,
    create,
    settings: new PersonalIntegrationSettings(
      prisma,
      new EncryptedSecretStore("offline-test-key"),
      create,
    ),
  };
}

describe("personal integration credentials", () => {
  it("encrypts at rest, isolates users and fences rotation and revoke/recreate", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-first-key" }, context);
    expect(JSON.stringify([...f.rows.values()])).not.toContain("fake-first-key");
    expect(await f.settings.prepare("bob", "composio")).toBeUndefined();
    const old = await f.settings.prepare("alice", "composio");
    expect(await old?.recheck(prisma)).toBe(true);
    await f.settings.save({ provider: "composio", apiKey: "fake-second-key" }, context);
    expect(await old?.recheck(prisma)).toBe(false);
    const rotated = await f.settings.prepare("alice", "composio");
    await f.settings.revoke("alice", "composio");
    expect(await f.settings.prepare("alice", "composio")).toBeUndefined();
    await f.settings.save({ provider: "composio", apiKey: "fake-second-key" }, context);
    expect(await rotated?.recheck(prisma)).toBe(false);
  });

  it("authenticates ciphertext against the user and credential revision", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-bound-key" }, context);
    const aliceKey = JSON.stringify({ userId: "alice", provider: "composio" });
    const bobKey = JSON.stringify({ userId: "bob", provider: "composio" });
    const alice = f.rows.get(aliceKey)!;
    f.rows.set(bobKey, { ...alice });
    await expect(f.settings.prepare("bob", "composio")).rejects.toThrow();
    f.rows.set(aliceKey, { ...alice, revision: "different-revision" });
    await expect(f.settings.prepare("alice", "composio")).rejects.toThrow();
  });

  it("rejects an empty key before contacting the provider or writing a vault record", async () => {
    const f = fixture();
    await expect(f.settings.save({ provider: "composio", apiKey: "   " }, context)).rejects.toThrow(
      "Invalid integration credentials",
    );
    expect(f.create).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
  });

  it("revoking another user's credential does not remove the owner's key", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-owned-key" }, context);
    await f.settings.revoke("bob", "composio");
    expect(await f.settings.configured("alice", "composio")).toBe(true);
    expect(await f.settings.configured("bob", "composio")).toBe(false);
  });

  it("keeps the current generation usable when persistence of a replacement fails", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-working-key" }, context);
    const current = await f.settings.prepare("alice", "composio");
    const before = [...f.rows.values()];
    vi.mocked(prisma.userIntegrationProviderConfig.upsert).mockRejectedValueOnce(
      new Error("offline-storage-failure"),
    );
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-replacement-key" }, context),
    ).rejects.toThrow("offline-storage-failure");
    expect([...f.rows.values()]).toEqual(before);
    expect(await current?.recheck(prisma)).toBe(true);
    expect(await f.settings.prepare("alice", "composio")).toBeDefined();
  });

  it("preserves a working key on failed verification without exposing provider errors", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-good" }, context);
    const before = [...f.rows.values()];
    f.verify.mockRejectedValueOnce(new Error("fake-sensitive-provider-detail"));
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-bad" }, context),
    ).rejects.toThrow("Could not verify these credentials");
    expect([...f.rows.values()]).toEqual(before);
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-bad" }, { ...context, userId: "" }),
    ).rejects.toThrow("personal account");
  });

  it("does not store a key when the provider cannot be reached", async () => {
    const f = fixture();
    const timeout = new Error("fetch failed");
    (timeout as Error & { cause?: unknown }).cause = Object.assign(new Error("connect"), {
      code: "ECONNREFUSED",
    });
    f.verify.mockRejectedValueOnce(timeout);
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-unreached-key" }, context),
    ).rejects.toThrow("Could not reach the integration provider");
    expect(f.rows.size).toBe(0);
    f.verify.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }));
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-rejected-key" }, context),
    ).rejects.toThrow("Could not verify these credentials");
    expect(f.rows.size).toBe(0);
  });
});

describe("legacy personal integration import", () => {
  async function legacy() {
    const source = new EncryptedSecretStore("offline-legacy-key");
    const config = { provider: "composio" as const, apiKey: "fake-legacy-key" };
    const stored = await source.put(JSON.stringify(config), context, {
      recordId: "integration-provider:user:alice:composio",
    });
    return {
      source,
      config,
      row: {
        userId: "alice",
        provider: "composio" as const,
        ciphertext: stored.ciphertext,
        revision: 7,
      },
    };
  }

  it("rebinds the old key for the current resolver without contacting the provider or changing the source", async () => {
    const f = fixture();
    const old = await legacy();
    const before = { ...old.row };
    await expect(f.settings.importLegacy(old.row, old.source, context)).resolves.toBe("imported");
    expect(old.row).toEqual(before);
    const saved = [...f.rows.values()][0]!;
    expect(saved.revision).toBe("legacy-7");
    expect(saved.ciphertext).not.toBe(old.row.ciphertext);
    expect(saved.ciphertext).not.toContain(old.config.apiKey);
    await expect(f.settings.prepare("alice", "composio")).resolves.toBeDefined();
    expect(f.create).toHaveBeenCalledWith(old.config);
    expect(f.verify).not.toHaveBeenCalled();
    await expect(f.settings.prepare("bob", "composio")).resolves.toBeUndefined();
  });

  it("keeps the imported ciphertext unchanged on retry", async () => {
    const f = fixture();
    const old = await legacy();
    await f.settings.importLegacy(old.row, old.source, context);
    const before = [...f.rows.values()][0];
    await expect(f.settings.importLegacy(old.row, old.source, context)).resolves.toBe("existing");
    expect([...f.rows.values()]).toEqual([before]);
  });

  it("rejects another user before reading their source secret", async () => {
    const f = fixture();
    const old = await legacy();
    const read = vi.spyOn(old.source, "load");
    await expect(
      f.settings.importLegacy(old.row, old.source, { ...context, userId: "bob" }),
    ).rejects.toThrow("account does not match");
    expect(read).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
  });

  it("does not replace a credential already saved in the destination", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-current-key" }, context);
    const before = [...f.rows.values()][0];
    const old = await legacy();
    await expect(f.settings.importLegacy(old.row, old.source, context)).rejects.toThrow(
      "already exists",
    );
    expect([...f.rows.values()]).toEqual([before]);
    await f.settings.prepare("alice", "composio");
    expect(f.create).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-current-key" });
  });

  it("writes nothing when the source key cannot decrypt the credential", async () => {
    const f = fixture();
    const old = await legacy();
    await expect(
      f.settings.importLegacy(old.row, new EncryptedSecretStore("wrong-fixture-key"), context),
    ).rejects.toThrow();
    expect(f.rows.size).toBe(0);
  });
});

it("dispatches configured wrappers by account and fences transaction credentials", async () => {
  const f = fixture();
  vi.spyOn(prisma.integrationProviderConfig, "findUnique").mockResolvedValue(null);
  const fallback = new ComposioConnector({ apiKey: "fake-deployment-key" });
  const settings = new IntegrationProviderSettings(
    prisma,
    new EncryptedSecretStore("offline-test-key"),
    "fake-identity",
    { composio: fallback },
    undefined,
    f.settings,
  );
  expect(await settings.resolve("composio")).toBe(fallback);
  expect(await settings.resolve("composio", "bob")).toBeUndefined();
  expect(await settings.resolve("composio", "")).toBeUndefined();
  await f.settings.save({ provider: "composio", apiKey: "fake-personal-key" }, context);
  const wrapper = settings.providers().find((provider) => provider.describe().id === "composio");
  if (!wrapper) throw new Error("Missing fixture provider");
  expect(await wrapper.listConnectedExternalIds({ ...context, userId: "bob" })).toEqual([]);
  expect(await wrapper.listConnectedExternalIds(context)).toEqual([]);
  expect(f.verify).toHaveBeenCalledTimes(2);
  const prepared = await prepareManagedConnectorForTransaction(wrapper, "alice");
  expect(await prepared.recheck?.(prisma)).toBe(true);
  await expect(
    prepared.provider?.listConnectedExternalIds({ ...context, userId: "bob" }),
  ).rejects.toThrow("account does not match");
  await f.settings.revoke("alice", "composio");
  expect(await prepared.recheck?.(prisma)).toBe(false);
  expect(await settings.resolve("composio", "alice")).toBeUndefined();
});

describe("one key per install (owner decision 2026-11-13)", () => {
  function shared(owner: string | null) {
    const f = fixture();
    vi.spyOn(prisma.integrationProviderConfig, "findUnique").mockResolvedValue(null);
    const settings = new IntegrationProviderSettings(
      prisma,
      new EncryptedSecretStore("offline-test-key"),
      "fake-identity",
      {},
      undefined,
      f.settings,
      async () => owner,
    );
    return { f, settings };
  }

  it("serves the owner's key to every account and keeps app connections per account", async () => {
    const { f, settings } = shared("alice");
    expect(await settings.needsPersonalKey("bob")).toBe(true);
    await settings.savePersonalKey("fake-owner-key", context);
    expect(await settings.needsPersonalKey("alice")).toBe(false);
    expect(await settings.needsPersonalKey("bob")).toBe(false);
    expect(await settings.resolve("composio", "bob")).toBeDefined();
    const wrapper = settings.providers().find((provider) => provider.describe().id === "composio");
    if (!wrapper) throw new Error("Missing fixture provider");
    await wrapper.listConnectedExternalIds({ ...context, userId: "bob" });
    expect(f.verify).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "bob" }));
  });

  it("lets only the owner paste, replace or remove the key", async () => {
    const { f, settings } = shared("alice");
    const bob = { ...context, userId: "bob" };
    expect(await settings.canManageKey("alice")).toBe(true);
    expect(await settings.canManageKey("bob")).toBe(false);
    await expect(settings.savePersonalKey("fake-key", bob)).rejects.toThrow("owner");
    await expect(settings.preparePersonalKey("fake-key", bob)).rejects.toThrow("owner");
    await expect(settings.revokePersonal("bob")).rejects.toThrow("owner");
    expect(f.rows.size).toBe(0);
  });

  it("serves no key and lets nobody change it before an owner exists", async () => {
    const { settings } = shared(null);
    expect(await settings.needsPersonalKey("alice")).toBe(true);
    expect(await settings.canManageKey("alice")).toBe(false);
    expect(await settings.resolve("composio", "alice")).toBeUndefined();
  });
});
