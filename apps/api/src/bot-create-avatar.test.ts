import { createRouterClient, implement } from "@orpc/server";
import type { Actor, Bot } from "@rakazo/contracts";
import { appContract } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { botsRoutes } from "./routes/bots.js";
import type { RouterContext } from "./routes/context.js";

it.each(["vnbot", "organic", undefined] as const)(
  "keeps the selected %s avatar set at the bot creation boundary",
  async (avatarSet) => {
    const actor: Actor = {
      userId: "user-1",
      spaceId: "space-1",
      email: "user@example.test",
      isDeploymentOwner: false,
    };
    const created: Bot = {
      id: "bot-1",
      spaceId: actor.spaceId,
      name: "Scout",
      title: "",
      description: "",
      instructions: "",
      color: "#659D50::shape_4",
      avatarSet,
      notifyOnFinish: true,
      pinned: false,
      sectionId: null,
      archivedAt: null,
      unread: false,
      parentBotId: null,
      memoryScope: null,
      threadId: "thread-1",
      preview: "",
      status: "idle",
      computerMode: "team",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      voiceId: null,
      autoSpeak: false,
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      teamChatAmbientEnabled: false,
      teamChatRules: "",
      webhookConfigured: false,
      spawnKey: null,
      runErrorId: null,
      fleetManagement: true,
      replyMode: "chat",
      disabledBuiltinTools: [],
    };
    const createBot = vi.fn(async () => created);
    const os = implement(appContract).$context<{ actor: Actor }>();
    const router = botsRoutes({
      authed: os,
      repos: { createBot },
      deps: { env: { agentRuntime: "scripted" } },
    } as unknown as RouterContext);
    const client = createRouterClient(
      // Only the bots routes are built here; the rest of the contract is not exercised.
      os.router(router as unknown as Parameters<typeof os.router>[0]),
      { context: { actor } },
    );
    // Only the repository write is replaced: the handler receives the contract-validated input.
    await client.bots.create({ name: "Scout", avatarSet, color: "#659D50::shape_4" });
    expect(createBot).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ name: "Scout", avatarSet, color: "#659D50::shape_4" }),
    );
  },
);
