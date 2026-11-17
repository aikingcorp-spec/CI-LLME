import { randomUUID } from "node:crypto";
import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import {
  bootstrapUserSpace,
  createDb,
  currentDbContext,
  machineOwnerUserId,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IntegrationKeyOwnerError,
  IntegrationProviderSettings,
} from "./integration-provider-settings.js";
import { PersonalIntegrationSettings } from "./personal-integration-settings.js";
import { EncryptedSecretStore } from "./secrets.js";

const suite =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;
const encryptionKey = "offline-m11-shared-key";

type Call = { op: string; apiKey: string; userId: string | undefined; scope: string | undefined };

function offlineConnector(apiKey: string, calls: Call[], op: string): ManagedConnectorProvider {
  return {
    describe: () => ({
      id: "composio",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    }),
    discoverTools: async () => [],
    connectionReady: async () => true,
    async begin(_request, context) {
      calls.push({ op: "begin", apiKey, userId: context.userId, scope: currentDbContext()?.kind });
      return { authorizationUrl: "https://oauth.example.test/authorize", state: context.userId! };
    },
    async complete(_request, context) {
      return { connectionRef: `fixture:${context.userId}` };
    },
    revoke: async () => {},
    async *execute(_call, context) {
      calls.push({
        op: "execute",
        apiKey,
        userId: context.userId,
        scope: currentDbContext()?.kind,
      });
      yield { type: "result", data: { userId: context.userId } };
    },
    async listConnectedExternalIds(context: AdapterContext) {
      calls.push({ op, apiKey, userId: context.userId, scope: currentDbContext()?.kind });
      return op === "env" ? ["env"] : ["gmail"];
    },
    async catalog(context: AdapterContext) {
      calls.push({
        op: op === "env" ? "env" : "catalog",
        apiKey,
        userId: context.userId,
        scope: currentDbContext()?.kind,
      });
      return [];
    },
  };
}

function settingsFor(prisma: ReturnType<typeof createDb>["prisma"], calls: Call[]) {
  const secrets = new EncryptedSecretStore(encryptionKey);
  const personal = new PersonalIntegrationSettings(prisma, secrets, (config) => {
    expect(currentDbContext()?.kind).toBe("tenant");
    if (config.provider !== "composio" || !("apiKey" in config)) {
      throw new Error("Unexpected offline provider");
    }
    return offlineConnector(config.apiKey, calls, "provider");
  });
  return new IntegrationProviderSettings(
    prisma,
    secrets,
    encryptionKey,
    { composio: offlineConnector("env-fallback", calls, "env") },
    undefined,
    personal,
    () => machineOwnerUserId(prisma),
  );
}

function contextFor(userId: string, spaceId: string): AdapterContext {
  return {
    userId,
    spaceId,
    operationId: "shared-key",
    traceId: "shared-key",
    signal: new AbortController().signal,
  };
}

suite("shared install key under row security (offline provider)", () => {
  let apiDb: ReturnType<typeof createDb>;
  let workerDb: ReturnType<typeof createDb>;
  let api: IntegrationProviderSettings;
  let worker: IntegrationProviderSettings;
  const apiCalls: Call[] = [];
  const workerCalls: Call[] = [];
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const otherId = randomUUID();
  const userIds = [ownerId, memberId, otherId];
  const orgIds: string[] = [];
  let ownerSpace = "";
  let memberSpace = "";
  let otherSpace = "";

  beforeAll(async () => {
    apiDb = createDb(process.env.DATABASE_URL!, { encryptContent: false });
    workerDb = createDb(process.env.DATABASE_URL!, { encryptContent: false });
    api = settingsFor(apiDb.prisma, apiCalls);
    worker = settingsFor(workerDb.prisma, workerCalls);
    const createdAt = [new Date(1), new Date(2), new Date(3)];
    await runAsSystem("seed shared integration key fixture", async () => {
      for (const [index, id] of userIds.entries()) {
        await apiDb.prisma.user.create({
          data: {
            id,
            email: `${id}@example.test`,
            emailVerified: true,
            name: "Fixture",
            createdAt: createdAt[index],
          },
        });
        const space = await bootstrapUserSpace(apiDb.prisma, { id });
        const storedSpace = await apiDb.prisma.space.findUniqueOrThrow({
          where: { id: space.spaceId },
          select: { organizationId: true },
        });
        orgIds.push(storedSpace.organizationId);
        if (index === 0) ownerSpace = space.spaceId;
        if (index === 1) memberSpace = space.spaceId;
        if (index === 2) otherSpace = space.spaceId;
      }
    });
    expect(await machineOwnerUserId(apiDb.prisma)).toBe(ownerId);
  });

  beforeEach(async () => {
    apiCalls.length = 0;
    workerCalls.length = 0;
    await runAsSystem("clear shared integration key fixture", () =>
      apiDb.prisma.userIntegrationProviderConfig.deleteMany({
        where: { userId: { in: userIds } },
      }),
    );
  });

  afterAll(async () => {
    if (!apiDb) return;
    await runAsSystem("remove shared integration key fixture", async () => {
      await apiDb.prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
      await apiDb.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await Promise.all([apiDb.pool.end(), workerDb.pool.end()]);
  });

  function composio(settings: IntegrationProviderSettings) {
    const provider = settings.providers().find((item) => item.describe().id === "composio");
    if (!provider) throw new Error("Missing composio provider");
    return provider;
  }

  it("lets a member use the owner key and still hides the raw secret", async () => {
    const owner = contextFor(ownerId, ownerSpace);
    const member = contextFor(memberId, memberSpace);
    const memberActor = { userId: memberId, spaceId: memberSpace };
    await runAsTenant({ userId: ownerId, spaceId: ownerSpace }, () =>
      api.savePersonalKey("fake-shared-key", owner),
    );
    expect(apiCalls).toEqual([
      expect.objectContaining({
        op: "provider",
        apiKey: "fake-shared-key",
        userId: ownerId,
        scope: "tenant",
      }),
    ]);
    await runAsTenant(memberActor, async () => {
      expect(await api.canManageKey(memberId)).toBe(false);
      expect(await api.needsPersonalKey(memberId)).toBe(false);
      expect(currentDbContext()).toMatchObject({ kind: "tenant", userId: memberId });
      expect(
        await apiDb.prisma.userIntegrationProviderConfig.findMany({
          where: { userId: ownerId },
          select: { ciphertext: true },
        }),
      ).toEqual([]);
      expect(
        await workerDb.prisma.userIntegrationProviderConfig.count({ where: { userId: ownerId } }),
      ).toBe(0);
      expect(
        (
          await apiDb.prisma.userIntegrationProviderConfig.updateMany({
            where: { userId: ownerId },
            data: { revision: "member-write" },
          })
        ).count,
      ).toBe(0);
      expect(
        (
          await apiDb.prisma.userIntegrationProviderConfig.deleteMany({
            where: { userId: ownerId },
          })
        ).count,
      ).toBe(0);
      expect(await composio(api).catalog(member)).toEqual([]);
      expect(await composio(api).listConnectedExternalIds(member)).toEqual(["gmail"]);
    });
    expect(apiCalls.at(-1)).toMatchObject({
      op: "provider",
      apiKey: "fake-shared-key",
      userId: memberId,
      scope: "tenant",
    });
    expect(apiCalls.some((call) => call.op === "env" || call.scope === "system")).toBe(false);
    await expect(api.savePersonalKey("fake-member-key", member)).rejects.toBeInstanceOf(
      IntegrationKeyOwnerError,
    );
    await expect(api.preparePersonalKey("fake-member-key", member)).rejects.toBeInstanceOf(
      IntegrationKeyOwnerError,
    );
    await expect(api.revokePersonal(memberId)).rejects.toBeInstanceOf(IntegrationKeyOwnerError);
    const stored = await runAsSystem("inspect shared integration ciphertext", () =>
      apiDb.prisma.userIntegrationProviderConfig.findUniqueOrThrow({
        where: { userId_provider: { userId: ownerId, provider: "composio" } },
      }),
    );
    expect(stored.ciphertext).not.toContain("fake-shared-key");
    expect(stored.revision).not.toBe("member-write");
  });

  it("keeps a later personal-space owner from managing the install key", async () => {
    const owner = contextFor(ownerId, ownerSpace);
    const other = contextFor(otherId, otherSpace);
    await runAsTenant({ userId: ownerId, spaceId: ownerSpace }, () =>
      api.savePersonalKey("fake-shared-key", owner),
    );
    expect(await api.canManageKey(ownerId)).toBe(true);
    expect(await api.canManageKey(otherId)).toBe(false);
    await expect(api.savePersonalKey("fake-other-key", other)).rejects.toBeInstanceOf(
      IntegrationKeyOwnerError,
    );
    await expect(api.revokePersonal(otherId)).rejects.toBeInstanceOf(IntegrationKeyOwnerError);
    await runAsTenant({ userId: otherId, spaceId: otherSpace }, async () => {
      expect(await api.needsPersonalKey(otherId)).toBe(false);
      expect(await composio(api).listConnectedExternalIds(other)).toEqual(["gmail"]);
      expect(currentDbContext()).toMatchObject({ kind: "tenant", userId: otherId });
      expect(
        await apiDb.prisma.userIntegrationProviderConfig.count({ where: { userId: ownerId } }),
      ).toBe(0);
    });
    expect(apiCalls.at(-1)).toMatchObject({
      apiKey: "fake-shared-key",
      userId: otherId,
      scope: "tenant",
    });
  });

  it("shows rotation and removal to another connection and does not fall back to an env key", async () => {
    const owner = contextFor(ownerId, ownerSpace);
    const member = contextFor(memberId, memberSpace);
    const ownerActor = { userId: ownerId, spaceId: ownerSpace };
    const memberActor = { userId: memberId, spaceId: memberSpace };
    await runAsTenant(ownerActor, () => api.savePersonalKey("fake-shared-key-one", owner));
    const first = await runAsTenant(memberActor, () => worker.prepare("composio", memberId));
    await runAsTenant(memberActor, async () => {
      expect(await composio(worker).listConnectedExternalIds(member)).toEqual(["gmail"]);
      await workerDb.prisma.$transaction(async (tx) => {
        expect(await first.recheck?.(tx)).toBe(true);
        expect(await tx.userIntegrationProviderConfig.count({ where: { userId: ownerId } })).toBe(
          0,
        );
        expect(currentDbContext()).toMatchObject({ kind: "tenant", userId: memberId });
      });
    });
    expect(workerCalls.at(-1)).toMatchObject({
      apiKey: "fake-shared-key-one",
      userId: memberId,
      scope: "tenant",
    });
    await runAsTenant(ownerActor, () => api.savePersonalKey("fake-shared-key-two", owner));
    await runAsTenant(memberActor, async () => {
      await workerDb.prisma.$transaction(async (tx) => {
        expect(await first.recheck?.(tx)).toBe(false);
        expect(await tx.userIntegrationProviderConfig.count({ where: { userId: ownerId } })).toBe(
          0,
        );
      });
      expect(await composio(worker).catalog(member)).toEqual([]);
    });
    expect(workerCalls.at(-1)).toMatchObject({
      op: "catalog",
      apiKey: "fake-shared-key-two",
      userId: memberId,
      scope: "tenant",
    });
    await runAsTenant(ownerActor, () => api.revokePersonal(ownerId));
    await runAsTenant(memberActor, async () => {
      expect(await worker.resolve("composio", memberId)).toBeUndefined();
      expect(await worker.needsPersonalKey(memberId)).toBe(true);
      expect(await composio(worker).listConnectedExternalIds(member)).toEqual([]);
      expect(
        await workerDb.prisma.userIntegrationProviderConfig.count({ where: { userId: ownerId } }),
      ).toBe(0);
      expect(currentDbContext()).toMatchObject({ kind: "tenant", userId: memberId });
    });
    expect(
      await runAsSystem("confirm the shared integration key is gone", () =>
        apiDb.prisma.userIntegrationProviderConfig.count({ where: { userId: ownerId } }),
      ),
    ).toBe(0);
    expect([...apiCalls, ...workerCalls].some((call) => call.op === "env")).toBe(false);
  });

  it("keeps each OAuth and tool caller outside system scope", async () => {
    const owner = contextFor(ownerId, ownerSpace);
    await runAsTenant(owner, () => api.savePersonalKey("fake-shared-key", owner));
    const refs: string[] = [];
    for (const actor of [owner, contextFor(memberId, memberSpace)]) {
      await runAsTenant(actor, async () => {
        const provider = composio(api);
        const auth = await provider.begin(
          { provider: "gmail", redirectUrl: "https://app.example.test/callback" },
          actor,
        );
        expect(auth.state).toBe(actor.userId);
        refs.push((await provider.complete({ state: auth.state }, actor)).connectionRef);
        const results = [];
        for await (const event of provider.execute(
          { tool: "fixture", args: {}, executionId: actor.userId! },
          actor,
        )) {
          results.push(event);
        }
        expect(results).toEqual([{ type: "result", data: { userId: actor.userId } }]);
        expect(apiCalls.slice(-2)).toEqual([
          expect.objectContaining({ op: "begin", userId: actor.userId, scope: "tenant" }),
          expect.objectContaining({ op: "execute", userId: actor.userId, scope: "tenant" }),
        ]);
      });
    }
    expect(new Set(refs).size).toBe(2);
  });

  it("restores tenant scope when shared-key decoding fails", async () => {
    await runAsSystem("seed malformed ciphertext owned by this test", () =>
      apiDb.prisma.userIntegrationProviderConfig.create({
        data: { userId: ownerId, provider: "composio", ciphertext: "invalid", revision: "bad" },
      }),
    );
    await runAsTenant({ userId: memberId, spaceId: memberSpace }, async () => {
      await expect(api.resolve("composio", memberId)).rejects.toThrow();
      expect(currentDbContext()).toMatchObject({ kind: "tenant", userId: memberId });
      expect(
        await apiDb.prisma.userIntegrationProviderConfig.count({ where: { userId: ownerId } }),
      ).toBe(0);
      expect(apiCalls).toEqual([]);
    });
  });
});
