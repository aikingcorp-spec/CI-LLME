import { createRouterClient } from "@orpc/server";
import type { Actor, PlanLimits } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

const other = { ...actor, userId: "user-2", email: "other@example.test" } satisfies Actor;

const usageRow = {
  id: "usage-1",
  botId: "bot-1",
  runId: "run-1",
  provider: "anthropic",
  model: "example",
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cacheWrite1hTokens: null,
  reasoningTokens: null,
  totalTokens: 14,
  costUsd: 0.01,
  costSource: null,
  pricingVersion: null,
  usageSource: null,
  callId: null,
  operationId: null,
  operationKind: "answer",
  parentRunId: null,
  agentId: null,
  createdAt: new Date("2026-11-10T12:00:00.000Z"),
};

function harness() {
  const credentials = [
    { id: "c1", provider: "anthropic", label: "me@example.com", secretId: "s1", userId: "user-1" },
    {
      id: "c2",
      provider: "anthropic",
      label: "other@example.com",
      secretId: "s2",
      userId: "user-2",
    },
  ];
  const whereSeen: unknown[] = [];
  const prisma = {
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        whereSeen.push(where);
        return credentials.filter((row) => row.userId === where.userId);
      }),
    },
    secret: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        where.userId === "user-1" ? [{ id: "s1", ciphertext: "cipher-1" }] : [],
      ),
    },
    usageRecord: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; spaceId: string } }) =>
        where.userId === actor.userId && where.spaceId === actor.spaceId ? [usageRow] : [],
      ),
      aggregate: vi.fn(async () => ({
        _sum: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd: 0.01 },
        _count: { _all: 1, inputTokens: 1, outputTokens: 1, totalTokens: 1, costUsd: 1 },
      })),
      groupBy: vi.fn(async ({ by }: { by: string[] }) =>
        by[0] === "provider"
          ? [
              {
                provider: "anthropic",
                model: "example",
                _sum: { inputTokens: 10, outputTokens: 4, totalTokens: 14, costUsd: 0.01 },
                _count: { _all: 1, inputTokens: 1, outputTokens: 1, totalTokens: 1, costUsd: 1 },
              },
            ]
          : [{ runId: "run-1", parentRunId: null }],
      ),
    },
  };
  const read = vi.fn(async (key: string) =>
    key.startsWith("user-1:")
      ? [{ period: "week" as const, usedPercent: 64, resetsAt: null }]
      : null,
  );
  const refresh = vi.fn();
  const deps = {
    prisma,
    secrets: {
      load: vi.fn(async () => '{"type":"oauth","access":"hidden","refresh":"hidden","expires":1}'),
    },
    planLimits: { read },
    refreshExpiredModelCredential: refresh,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    },
    dataDir: "/tmp/vnbot-usage-limits-test",
  } as unknown as RouterDeps;
  const clientFor = (next: Actor | null) =>
    createRouterClient(createRouter(deps), { context: { actor: next } });
  return { clientFor, read, refresh, prisma, whereSeen };
}

describe("usage.limits", () => {
  it("requires a signed-in member", async () => {
    const { clientFor, read } = harness();
    await expect(clientFor(null).usage.limits()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns only the actor's readings and still counts token usage separately", async () => {
    const { clientFor, read, refresh, prisma } = harness();
    const limits = await clientFor(actor).usage.limits();
    expect(limits).toEqual([
      {
        credentialId: "c1",
        name: "Claude",
        label: "me@example.com",
        windows: [{ period: "week", usedPercent: 64, resetsAt: null }],
      },
    ] satisfies PlanLimits[]);
    expect(JSON.stringify(limits)).not.toContain("hidden");
    expect(read).toHaveBeenCalledWith(
      "user-1:s1",
      "anthropic",
      expect.objectContaining({ access: "hidden" }),
    );
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", spaceId: "space-1" }),
      "s1",
      "anthropic",
    );

    const otherLimits = await clientFor(other).usage.limits();
    expect(otherLimits).toEqual([]);
    expect(JSON.stringify(otherLimits)).not.toContain("64");

    const listed = await clientFor(actor).usage.list();
    expect(listed).toMatchObject([{ id: "usage-1", totalTokens: 14, inputTokens: 10 }]);
    const summary = await clientFor(actor).usage.summary();
    expect(summary).toMatchObject({ runs: 1, totalTokens: 14, inputTokens: 10, outputTokens: 4 });
    expect(prisma.usageRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space-1", userId: "user-1" },
      }),
    );
  });
});
