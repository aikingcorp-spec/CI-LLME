import type { OAuthCredential } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "./model-secret.js";
import {
  PlanLimitsReader,
  parseChatGptPlanLimits,
  parseClaudePlanLimits,
  readMemberPlanLimits,
} from "./plan-limits.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const SECRET = "access-token-should-not-leak";

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access: SECRET,
    refresh: "refresh-token",
    expires: NOW + 3_600_000,
    ...overrides,
  };
}

const claudeBody = {
  five_hour: { utilization: 42, resets_at: "2026-11-10T15:00:00Z" },
  seven_day: { utilization: 12.5, resets_at: "2026-11-14T00:00:00Z" },
  seven_day_opus: { utilization: 90, resets_at: "2026-11-14T00:00:00Z" },
};

function json(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

function request(
  overrides: Partial<Parameters<PlanLimitsReader["read"]>[0]> = {},
): Parameters<PlanLimitsReader["read"]>[0] {
  return {
    userId: "user-1",
    credentialId: "cred-1",
    secretId: "secret-1",
    provider: "anthropic",
    credential: credential(),
    ...overrides,
  };
}

describe("parseClaudePlanLimits", () => {
  it("reads the shared windows and skips a per-model window", () => {
    expect(parseClaudePlanLimits(claudeBody)).toEqual([
      { period: "session", usedPercent: 42, resetsAt: "2026-11-10T15:00:00.000Z" },
      { period: "week", usedPercent: 12.5, resetsAt: "2026-11-14T00:00:00.000Z" },
    ]);
  });

  it("leaves out a window the plan does not report", () => {
    expect(
      parseClaudePlanLimits({ five_hour: { utilization: 3, resets_at: null }, seven_day: null }),
    ).toEqual([{ period: "session", usedPercent: 3, resetsAt: null }]);
  });

  it("rejects a malformed percent", () => {
    expect(() => parseClaudePlanLimits({ five_hour: { utilization: "42" } })).toThrow();
  });
});

describe("parseChatGptPlanLimits", () => {
  it("names each window by its length and clamps a percent", () => {
    expect(
      parseChatGptPlanLimits({
        rate_limit: {
          primary_window: {
            used_percent: 7,
            limit_window_seconds: 18_000,
            reset_at: 1_794_326_400,
          },
          secondary_window: { used_percent: 120, limit_window_seconds: 604_800, reset_at: null },
        },
      }),
    ).toEqual([
      { period: "session", usedPercent: 7, resetsAt: "2026-11-10T16:00:00.000Z" },
      { period: "week", usedPercent: 100, resetsAt: null },
    ]);
  });

  it("rejects a body without rate limits", () => {
    expect(() => parseChatGptPlanLimits({})).toThrow();
  });
});

describe("PlanLimitsReader", () => {
  it("reuses a fresh reading and does not ask the provider again", async () => {
    let now = NOW;
    const fetchImpl = vi.fn(async () => json(claudeBody));
    const reader = new PlanLimitsReader(fetchImpl, () => now);
    const first = await reader.read(request({ credential: credential({ accountId: "acct-a" }) }));
    now += 30_000;
    const again = await reader.read(
      request({ credential: credential({ access: "rotated-access", accountId: "acct-a" }) }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: "fresh", checkedAt: "2026-11-10T12:00:00.000Z" });
    expect(again).toEqual(first);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(again)).not.toContain(SECRET);
  });

  it("does not reuse an unidentified account after its sign-in token changes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(claudeBody))
      .mockResolvedValueOnce(json({}, 500));
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    await reader.read(request());
    const replaced = await reader.read(
      request({ credential: credential({ access: "new-account" }) }),
    );
    expect(replaced).toEqual({ status: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not let a caller mutate the cached reading", async () => {
    const reader = new PlanLimitsReader(
      async () => json(claudeBody),
      () => NOW,
    );
    const first = await reader.read(request());
    if (first?.status !== "fresh") throw Error("Expected a fresh reading");
    first.windows[0]!.usedPercent = 99;
    const second = await reader.read(request());
    expect(second).toMatchObject({ windows: [{ usedPercent: 42 }, { usedPercent: 12.5 }] });
    if (second?.status !== "fresh") throw Error("Expected a fresh cached reading");
    second.windows.splice(0);
    expect(await reader.read(request())).toMatchObject({
      windows: [{ usedPercent: 42 }, { usedPercent: 12.5 }],
    });
  });

  it.each([401, 403])("drops earlier numbers after an HTTP %s auth refusal", async (status) => {
    let now = NOW;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(claudeBody))
      .mockResolvedValueOnce(json({ error: SECRET }, status));
    const reader = new PlanLimitsReader(fetchImpl, () => now);
    await reader.read(request());
    now += 61_000;
    expect(await reader.read(request())).toEqual({ status: "unavailable" });
  });

  it("keeps the last reading as stale after a failure, then drops it", async () => {
    let now = NOW;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(claudeBody))
      .mockResolvedValue(json({ error: SECRET }, 500));
    const reader = new PlanLimitsReader(fetchImpl, () => now);
    await reader.read(request());
    now += 61_000;
    const stale = await reader.read(request());
    expect(stale).toMatchObject({
      status: "stale",
      checkedAt: "2026-11-10T12:00:00.000Z",
      windows: [{ usedPercent: 42 }, { usedPercent: 12.5 }],
    });
    expect(JSON.stringify(stale)).not.toContain(SECRET);
    now += 10_000;
    await reader.read(request());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 5_000;
    await reader.read(request());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    now = NOW + 31 * 60_000;
    const dropped = await reader.read(request());
    expect(dropped).toEqual({ status: "unavailable" });
    expect(JSON.stringify(dropped)).not.toContain("42");
  });

  it("does not invent a reading for an unsupported provider or a missing token", async () => {
    const fetchImpl = vi.fn();
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    expect(await reader.read(request({ provider: "openrouter" }))).toBeNull();
    expect(await reader.read(request({ credential: null }))).toEqual({ status: "unavailable" });
    expect(await reader.read(request({ credential: credential({ expires: NOW - 1 }) }))).toEqual({
      status: "unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("isolates cache and in-flight reads by user, credential, and account", async () => {
    const pending: Array<(body: unknown) => void> = [];
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push((body) => resolve(json(body)));
        }),
    );
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    const first = reader.read(request());
    const joined = reader.read(request());
    const otherAccount = reader.read(
      request({
        secretId: "secret-2",
        credential: credential({ accountId: "acct-b" }),
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const releaseOwn = pending[0];
    const releaseOther = pending[1];
    if (!releaseOwn || !releaseOther) throw new Error("expected two provider reads");
    releaseOwn({ five_hour: { utilization: 9, resets_at: null } });
    releaseOther({ five_hour: { utilization: 3, resets_at: null } });
    const [own, same, other] = await Promise.all([first, joined, otherAccount]);
    expect(own).toMatchObject({ status: "fresh", windows: [{ usedPercent: 9 }] });
    expect(same).toEqual(own);
    expect(other).toMatchObject({ status: "fresh", windows: [{ usedPercent: 3 }] });

    fetchImpl.mockResolvedValue(json({ error: "nope" }, 500));
    const rotated = await reader.read(
      request({
        credential: credential({ accountId: "acct-next", access: "next-token" }),
      }),
    );
    expect(rotated).toEqual({ status: "unavailable" });
    expect(JSON.stringify(rotated)).not.toContain("9");
  });

  it("cancels a caller without waiting and times out a hung provider read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fetchImpl = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const reader = new PlanLimitsReader(fetchImpl, () => NOW);
      const early = await reader.read(request({ signal: AbortSignal.abort() }));
      expect(early).toEqual({ status: "unavailable" });
      expect(fetchImpl).not.toHaveBeenCalled();

      const controller = new AbortController();
      const pending = reader.read(request({ signal: controller.signal }));
      controller.abort();
      await expect(pending).resolves.toEqual({ status: "unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const hung = reader.read(request({ userId: "user-2" }));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(hung).resolves.toEqual({ status: "unavailable" });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs the ChatGPT account and hides an error body", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000 } },
      }),
    );
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    expect(await reader.read(request({ provider: "openai-codex" }))).toEqual({
      status: "unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const signedIn = await reader.read(
      request({
        provider: "openai-codex",
        credential: credential({ accountId: "acct-1" }),
      }),
    );
    expect(signedIn).toEqual({
      status: "fresh",
      checkedAt: "2026-11-10T12:00:00.000Z",
      windows: [{ period: "session", usedPercent: 5, resetsAt: null }],
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["chatgpt-account-id"]).toBe("acct-1");
    expect((init.headers as Record<string, string>).originator).toBe("vnbot");

    fetchImpl.mockResolvedValue(json({ token: SECRET }, 500));
    const failed = await reader.read(
      request({
        userId: "user-9",
        provider: "openai-codex",
        credential: credential({ accountId: "acct-9" }),
      }),
    );
    expect(failed).toEqual({ status: "unavailable" });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  it("drops the oldest cached account once the cache is full", async () => {
    const fetchImpl = vi.fn(async () => json({ five_hour: { utilization: 1, resets_at: null } }));
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    for (let index = 0; index < 512; index += 1) {
      await reader.read(request({ userId: `user-${index}` }));
    }
    await reader.read(request({ userId: "user-new" }));
    const before = fetchImpl.mock.calls.length;
    await reader.read(request({ userId: "user-0" }));
    expect(fetchImpl.mock.calls.length).toBe(before + 1);
    await reader.read(request({ userId: "user-511" }));
    expect(fetchImpl.mock.calls.length).toBe(before + 1);
  });

  it("rejects an oversized or malformed provider body", async () => {
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
          controller.close();
        },
      }),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(json({ five_hour: { utilization: "nope" } }));
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    await expect(reader.read(request())).resolves.toEqual({ status: "unavailable" });
    await expect(reader.read(request({ userId: "user-malformed" }))).resolves.toEqual({
      status: "unavailable",
    });
  });
});

describe("readMemberPlanLimits", () => {
  function prismaFor(
    rowsByUser: Record<
      string,
      Array<{ id: string; provider: string; label: string; secretId: string }>
    >,
    secretsByUser: Record<string, Array<{ id: string; ciphertext: string }>>,
  ) {
    const mocked = {
      userModelCredential: {
        findMany: vi.fn(
          async ({ where }: { where: { userId: string } }) => rowsByUser[where.userId] ?? [],
        ),
      },
      secret: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; id: { in: string[] } } }) =>
          (secretsByUser[where.userId] ?? []).filter((secret) => where.id.in.includes(secret.id)),
        ),
      },
    };
    return mocked as typeof mocked & Parameters<typeof readMemberPlanLimits>[0]["prisma"];
  }

  it("lists signed-in allowances and skips keys, reconnects, and other people", async () => {
    const rows = [
      { id: "c1", provider: "anthropic", label: "me@example.com", secretId: "s1" },
      { id: "c2", provider: "anthropic", label: "Anthropic key", secretId: "s2" },
      { id: "c3", provider: "openai-codex", label: "ChatGPT", secretId: "s3" },
      { id: "c4", provider: "anthropic", label: "missing", secretId: "s4" },
    ];
    const plaintext: Record<string, string> = {
      s1: serializeModelSecret({ kind: "oauth", credential: credential() }),
      s2: serializeModelSecret({ kind: "api_key", key: "sk-test" }),
      s3: serializeModelSecret({ kind: "oauth", reconnectRequired: true }),
    };
    const prisma = prismaFor(
      { u1: rows, u2: [{ id: "c9", provider: "anthropic", label: "other", secretId: "s1" }] },
      {
        u1: rows.flatMap((row) =>
          plaintext[row.secretId] ? [{ id: row.secretId, ciphertext: row.secretId }] : [],
        ),
        u2: [],
      },
    );
    const reader = new PlanLimitsReader(
      async () => json(claudeBody),
      () => NOW,
    );
    const plans = await readMemberPlanLimits({
      prisma,
      secretStore: { load: async (ciphertext: string) => plaintext[ciphertext] ?? "" },
      userId: "u1",
      reader,
      onExpiredToken: vi.fn(),
      now: () => NOW,
    });
    expect(plans).toEqual([
      {
        credentialId: "c1",
        name: "Claude",
        label: "me@example.com",
        reading: {
          status: "fresh",
          checkedAt: "2026-11-10T12:00:00.000Z",
          windows: parseClaudePlanLimits(claudeBody),
        },
      },
      {
        credentialId: "c4",
        name: "Claude",
        label: "missing",
        reading: { status: "unavailable" },
      },
    ]);
    const other = await readMemberPlanLimits({
      prisma,
      secretStore: { load: async () => plaintext.s1 ?? "" },
      userId: "u2",
      reader,
      onExpiredToken: vi.fn(),
      now: () => NOW,
    });
    expect(other).toEqual([
      {
        credentialId: "c9",
        name: "Claude",
        label: "other",
        reading: { status: "unavailable" },
      },
    ]);
    expect(JSON.stringify(other)).not.toContain("42");
    expect(prisma.userModelCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "u2" }) }),
    );
    expect(prisma.secret.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u1", spaceId: null }),
      }),
    );
  });

  it("starts a refresh for an expired sign-in and does not show the old account after replacement", async () => {
    const rows = [{ id: "c1", provider: "anthropic", label: "Claude", secretId: "s1" }];
    const expired = serializeModelSecret({
      kind: "oauth",
      credential: credential({ expires: NOW - 1, accountId: "acct-old" }),
    });
    const prisma = prismaFor({ u1: rows }, { u1: [{ id: "s1", ciphertext: "x" }] });
    const onExpired = vi.fn();
    const fetchImpl = vi.fn(async () => json(claudeBody));
    const reader = new PlanLimitsReader(fetchImpl, () => NOW);
    const plans = await readMemberPlanLimits({
      prisma,
      secretStore: { load: async () => expired },
      userId: "u1",
      reader,
      onExpiredToken: onExpired,
      now: () => NOW,
    });
    expect(plans).toEqual([
      {
        credentialId: "c1",
        name: "Claude",
        label: "Claude",
        reading: { status: "unavailable" },
      },
    ]);
    expect(onExpired).toHaveBeenCalledWith("s1", "anthropic");
    expect(fetchImpl).not.toHaveBeenCalled();

    const replaced = serializeModelSecret({
      kind: "oauth",
      credential: credential({ accountId: "acct-new" }),
    });
    prisma.secret.findMany.mockResolvedValue([{ id: "s2", ciphertext: "y" }]);
    prisma.userModelCredential.findMany.mockResolvedValue([
      { id: "c1", provider: "anthropic", label: "Claude", secretId: "s2" },
    ]);
    fetchImpl.mockResolvedValue(json({ error: SECRET }, 500));
    const next = await readMemberPlanLimits({
      prisma,
      secretStore: { load: async () => replaced },
      userId: "u1",
      reader,
      onExpiredToken: vi.fn(),
      now: () => NOW,
    });
    expect(next[0]?.reading).toEqual({ status: "unavailable" });
    expect(JSON.stringify(next)).not.toContain(SECRET);
  });
});
