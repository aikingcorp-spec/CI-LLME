import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { CodexRealtimeCallError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { configureRealtimeVoice, connectRealtimeVoice } from "./realtime-voice.js";
import type { RouterDeps } from "./router.js";

const provider = vi.hoisted(() => ({
  create: vi.fn(async () => "v=0\r\nanswer"),
  refresh: vi.fn(),
}));
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  createCodexRealtimeCall: provider.create,
  refreshExpiredModelCredential: provider.refresh,
}));

function fixture() {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        name: "Fixture member",
        timezone: "Asia/Ho_Chi_Minh",
      })),
    },
    thread: { findFirst: vi.fn(async () => null) },
    bot: { findFirst: vi.fn(async () => ({ name: "Assistant", instructions: "" })) },
    userModelCredential: {
      findFirst: vi.fn(async () => ({ id: "owned-connection", secretId: "secret" })),
    },
    secret: { findFirst: vi.fn(async () => ({ id: "secret", ciphertext: "encrypted" })) },
    userRealtimeVoicePreference: {
      findUnique: vi.fn(async () => ({ credentialId: "owned-connection", voiceId: "cove" })),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  const secrets = {
    load: vi.fn(async () =>
      JSON.stringify({
        kind: "oauth",
        credential: {
          type: "oauth",
          access: "fixture-private-token",
          refresh: "fixture-refresh",
          expires: Date.now() + 3600_000,
          accountId: "fixture-account",
        },
      }),
    ),
  };
  const memory = { read: vi.fn(async () => ({ documents: [] })) };
  const deps = { prisma, secrets, memory } as unknown as RouterDeps;
  const actor: Actor = {
    userId: "owner",
    spaceId: "space",
    email: "fixture@example.test",
    isDeploymentOwner: false,
  };
  return { prisma, secrets, memory, deps, actor };
}

describe("personal native voice", () => {
  it("selects only an owned ChatGPT OAuth connection and stores no new credential", async () => {
    const f = fixture();
    await configureRealtimeVoice(f.deps, f.actor, {
      credentialId: "owned-connection",
      voiceId: "cove",
    });
    expect(f.prisma.userModelCredential.findFirst).toHaveBeenCalledWith({
      where: { id: "owned-connection", userId: "owner", provider: "openai-codex" },
    });
    expect(f.prisma.userRealtimeVoicePreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: "owner", credentialId: "owned-connection", voiceId: "cove" },
      }),
    );
  });
  it("rejects another account's model credential", async () => {
    const f = fixture();
    f.prisma.userModelCredential.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      configureRealtimeVoice(f.deps, f.actor, { credentialId: "someone-else", voiceId: "cove" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.prisma.userRealtimeVoicePreference.upsert).not.toHaveBeenCalled();
  });
  it("sends the token only to the adapter and returns only the SDP answer", async () => {
    const f = fixture();
    const result = await connectRealtimeVoice(
      f.deps,
      f.actor,
      { botId: "owned-bot", offer: "v=0\r\noffer" },
      new AbortController().signal,
    );
    expect(result).toEqual({ answer: "v=0\r\nanswer" });
    expect(JSON.stringify(result)).not.toContain("fixture-private-token");
    expect(provider.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "fixture-private-token",
        accountId: "fixture-account",
      }),
    );
    const request = vi.mocked(provider.create).mock.calls.at(-1)?.[0] as unknown as {
      context: string;
    };
    expect(request.context).toContain('"name":"Fixture member"');
    expect(request.context).not.toContain("fixture-private-token");
    expect(request.context).not.toContain("fixture@example.test");
  });
  it("rejects a foreign bot before refreshing or opening provider media", async () => {
    const f = fixture();
    f.prisma.bot.findFirst.mockResolvedValueOnce(null as never);
    provider.create.mockClear();
    provider.refresh.mockClear();
    await expect(
      connectRealtimeVoice(
        f.deps,
        f.actor,
        { botId: "foreign", offer: "v=0" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(f.memory.read).not.toHaveBeenCalled();
    expect(f.prisma.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

it.each([
  ["usage_limit", "TOO_MANY_REQUESTS", 429],
  ["rate_limit", "TOO_MANY_REQUESTS", 429],
  ["authorization", "FORBIDDEN", 403],
  ["unavailable", "SERVICE_UNAVAILABLE", 503],
] as const)(
  "preserves the safe %s failure across the RPC boundary",
  async (reason, code, status) => {
    const f = fixture();
    provider.create.mockRejectedValueOnce(
      new CodexRealtimeCallError(reason, "Safe account guidance"),
    );
    await expect(
      connectRealtimeVoice(
        f.deps,
        f.actor,
        { botId: "owned-bot", offer: "v=0" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code, status, message: "Safe account guidance" });
  },
);

it("serializes usage-limit guidance instead of an internal server error", async () => {
  const f = fixture();
  provider.create.mockRejectedValueOnce(
    new CodexRealtimeCallError("usage_limit", "Safe voice limit guidance"),
  );
  const rpc = new RPCHandler({
    connect: os.handler(() =>
      connectRealtimeVoice(
        f.deps,
        f.actor,
        { botId: "owned-bot", offer: "v=0" },
        new AbortController().signal,
      ),
    ),
  });
  const result = await rpc.handle(
    new Request("http://localhost/rpc/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    }),
    { prefix: "/rpc", context: {} },
  );
  expect(result.matched).toBe(true);
  expect(result.response?.status).toBe(429);
  const body = await result.response!.json();
  expect(body.json).toMatchObject({
    code: "TOO_MANY_REQUESTS",
    message: "Safe voice limit guidance",
  });
});
