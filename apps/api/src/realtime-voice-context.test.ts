import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { realtimeVoiceContext } from "./realtime-voice-context.js";
import type { RouterDeps } from "./router.js";
import { loadMessagePage } from "./thread-message-pages.js";

vi.mock("./thread-message-pages.js", () => ({
  loadMessagePage: vi.fn(async () => ({ messages: [] })),
}));
const actor: Actor = {
  userId: "fixture-user",
  spaceId: "fixture-space",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const prisma = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({ name: "Minh", timezone: "Asia/Ho_Chi_Minh" })),
    },
    thread: {
      findFirst: vi.fn(async () => ({
        id: "owned-thread",
        historyCompactionSummary: "Earlier project: a garden",
      })),
    },
  };
  const read = vi.fn(async (request: { scope: string }, context: AdapterContext) => ({
    documents: [
      {
        id: "doc",
        path: "MEMORY.md",
        revision: 1,
        content: `${context.userId}:${request.scope}:saved-preference`,
      },
    ],
  }));
  return { prisma, read, deps: { prisma, memory: { read } } as unknown as RouterDeps };
}

describe("native voice background context", () => {
  it("reads the owned profile, scoped memory and existing visible chat path", async () => {
    const f = fixture();
    vi.mocked(loadMessagePage).mockResolvedValueOnce({
      messages: [
        {
          role: "user",
          blocks: [
            { kind: "text", text: "Please keep the garden plan" },
            { kind: "tool_call", secret: "excluded-fixture" },
          ],
        },
        { role: "bot", blocks: [{ kind: "text", text: "The plan is ready" }] },
      ],
    } as never);
    const signal = new AbortController().signal;
    const context = JSON.parse(
      await realtimeVoiceContext(
        f.deps,
        actor,
        { name: "Gardener", instructions: "Help with gardens" },
        "owned-bot",
        signal,
      ),
    );
    expect(context.user).toEqual({ name: "Minh", timezone: "Asia/Ho_Chi_Minh" });
    expect(context.bot.name).toBe("Gardener");
    expect(context.userMemory).toContain("fixture-user:user:saved-preference");
    expect(context.botMemory).toContain("fixture-user:bot:saved-preference");
    expect(context.priorConversationSummary).toBe("Earlier project: a garden");
    expect(context.recentConversation).toEqual([
      { role: "user", text: "Please keep the garden plan" },
      { role: "bot", text: "The plan is ready" },
    ]);
    expect(JSON.stringify(context)).not.toContain("excluded-fixture");
    expect(f.prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: actor.userId },
      select: { name: true, timezone: true },
    });
    expect(f.prisma.thread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: "owned-bot", userId: actor.userId, spaceId: actor.spaceId },
      }),
    );
    expect(loadMessagePage).toHaveBeenCalledWith(f.prisma, "owned-thread", undefined, 12);
    for (const request of [{ scope: "user" }, { scope: "bot", botId: "owned-bot" }])
      expect(f.read).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          userId: actor.userId,
          spaceId: actor.spaceId,
          botId: "owned-bot",
          signal,
        }),
      );
  });

  it("reloads memory for each call, including edits, deletion and account changes", async () => {
    const f = fixture();
    const readContext = (who = actor) =>
      realtimeVoiceContext(
        f.deps,
        who,
        { name: "Bot", instructions: "" },
        "owned-bot",
        new AbortController().signal,
      );
    expect(await readContext()).toContain("fixture-user:user:saved-preference");
    f.read.mockResolvedValueOnce({ documents: [] });
    expect(JSON.parse(await readContext()).userMemory).toBe("");
    const next = JSON.parse(
      await readContext({ ...actor, userId: "second-user", spaceId: "second-space" }),
    );
    expect(next.userMemory).toContain("second-user:user:saved-preference");
    expect(next.userMemory).not.toContain("fixture-user");
  });

  it("bounds encoded Unicode/context fields and reserves memory for the user independently", async () => {
    const f = fixture();
    f.read.mockImplementation(async ({ scope }) => ({
      documents: [
        {
          id: "doc",
          path: "profile.md",
          revision: 2,
          content: scope === "user" ? "Remember my preferred name" : "\u0001🙂".repeat(30000),
        },
      ],
    }));
    vi.mocked(loadMessagePage).mockResolvedValueOnce({
      messages: Array.from({ length: 12 }, () => ({
        role: "user",
        blocks: [{ kind: "text", text: "\u0001🙂".repeat(1000) }],
      })),
    } as never);
    const text = await realtimeVoiceContext(
      f.deps,
      actor,
      { name: "Bot", instructions: "\u0001🙂".repeat(10000) },
      "owned-bot",
      new AbortController().signal,
    );
    expect(Buffer.byteLength(text)).toBeLessThan(24 * 1024);
    expect(JSON.parse(text).userMemory).toContain("Remember my preferred name");
    expect(text).not.toContain("�");
  });

  it("does not invent history when there is no thread, and propagates memory failures", async () => {
    const f = fixture();
    f.prisma.thread.findFirst.mockResolvedValueOnce(null as never);
    const context = JSON.parse(
      await realtimeVoiceContext(
        f.deps,
        actor,
        { name: "Bot", instructions: "" },
        "owned-bot",
        new AbortController().signal,
      ),
    );
    expect(context.recentConversation).toEqual([]);
    expect(context.priorConversationSummary).toBe("");
    f.read.mockRejectedValueOnce(new Error("Memory unavailable"));
    await expect(
      realtimeVoiceContext(
        f.deps,
        actor,
        { name: "Bot", instructions: "" },
        "owned-bot",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Memory unavailable");
  });
});
