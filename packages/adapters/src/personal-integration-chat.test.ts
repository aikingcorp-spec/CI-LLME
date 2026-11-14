import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationProviderSettings } from "./integration-provider-settings.js";
import { PersonalIntegrationSettings } from "./personal-integration-settings.js";
import type { RunContext } from "./run-context.js";
import { createRunSecretWriter } from "./run-secret.js";
import type { ToolCall } from "./run-tool-gate.js";
import { integrationTools } from "./run-tools-integrations.js";
import { EncryptedSecretStore } from "./secrets.js";

vi.mock("./run-progress.js", () => ({
  flushProgress: async () => {},
  publishMidTurnNarration: async () => undefined,
  showNarrationStatus: async () => {},
}));

vi.mock("./run-lifecycle.js", () => ({
  renewRunLease: async () => true,
  enqueueSteeringContinuation: async () => {},
}));
vi.mock("./run-notifications.js", () => ({
  notifyRun: async () => {},
  secretAskNotification: () => ({}),
}));
vi.mock("./run-context.js", () => ({
  pauseForSecret: () => ({ paused: true }),
  persistTurnCheckpoint: async () => {},
}));
const effect = vi.hoisted(() => ({ status: "intended", result: undefined as unknown }));
vi.mock("./run-effects.js", () => ({
  recordEffect: async () => ({ effect }),
  runScopedToolExecutionId: () => "scoped-call",
}));

function fixture(owner?: () => Promise<string | null>) {
  let row: { ciphertext: string; revision: string } | undefined;
  let blocks: unknown[] = [];
  let waiting = true;
  const verify = vi.fn(async () => []);
  const catalog = vi.fn(async () => [
    {
      connectorId: "composio",
      slug: "example",
      name: "Example",
      logo: null,
      connected: true,
      noAuth: false,
    },
  ]);
  const adapter = {
    listConnectedExternalIds: verify,
    catalog,
  } as unknown as ManagedConnectorProvider;
  const prisma = {
    run: { findFirst: async () => (waiting ? { userId: "user", botId: "bot" } : null) },
    message: { findFirst: async () => ({ blocks }) },
    userIntegrationProviderConfig: {
      findUnique: async ({ where }: { where: { userId_provider: { userId: string } } }) =>
        where.userId_provider.userId === "user" ? row : null,
      upsert: vi.fn(async ({ create }: { create: { ciphertext: string; revision: string } }) => {
        row = create;
      }),
      count: async () => (row ? 1 : 0),
    },
    secret: { findFirst: async () => null, count: async () => 0 },
    botSecret: { count: async () => 0 },
    vaultCredential: { count: async () => 0 },
    integrationProviderConfig: { count: async () => 0 },
  } as unknown as PrismaClient;
  const store = new EncryptedSecretStore("fake-offline-key");
  const personal = new PersonalIntegrationSettings(prisma, store, () => adapter);
  const settings = new IntegrationProviderSettings(
    prisma,
    store,
    "fake-identity",
    {},
    undefined,
    personal,
    owner,
  );
  const pause = vi.fn(async (input: { blocks: unknown[] }) => {
    blocks = input.blocks;
    return {};
  });
  const ctx = {
    deps: {
      prisma,
      secretStore: store,
      connectors: { managedProviders: () => settings.providers() },
      events: { pauseRunForInput: pause },
    },
    run: {
      id: "run",
      userId: "user",
      spaceId: "space",
      threadId: "thread",
      botId: "bot",
      trigger: "user",
    },
    runId: "run",
    context: { userId: "user", spaceId: "space" },
    bot: { id: "bot", name: "Bot" },
    thread: { id: "thread" },
    state: { reply: {} },
    attempt: { id: "attempt" },
    computer: { checkpoint: { flush: async () => {} } },
    settleRunningHelpers: async () => {},
    secrets: [],
  } as unknown as RunContext;
  const call = {
    name: "connect_app",
    args: { app: "example" },
    effectKey: "connect",
    executionId: "call",
    finish: async (value: unknown) => value,
  } as unknown as ToolCall;
  const answer = (by = "user", txSpace = "space") =>
    createRunSecretWriter(store, () => settings).withPrepared!(
      prisma,
      {
        runId: "run",
        threadId: "thread",
        messageId: "message",
        spaceId: "space",
        answeredByUserId: by,
        answer: "fake-personal-key",
      },
      async (writer) =>
        writer.store({
          userId: "user",
          botId: "bot",
          runId: "run",
          spaceId: txSpace,
          plaintext: "fake-personal-key",
          integrationSetup: "personal-key-v1",
          remember: true,
          tx: prisma as never,
        }),
    );
  return {
    ctx,
    call,
    pause,
    answer,
    verify,
    personal,
    prisma,
    row: () => row,
    catalog,
    cancel: () => {
      waiting = false;
    },
  };
}

beforeEach(() => {
  effect.status = "intended";
  effect.result = undefined;
});
describe("protected personal connector chat", () => {
  it("tells the bot to ask the owner instead of showing a key card to anyone else", async () => {
    const f = fixture(async () => "owner");
    const result = (await integrationTools.connect_app!(f.ctx, f.call)) as { error?: string };
    expect(result.error).toContain("owner of this computer has not added");
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    await expect(f.answer()).rejects.toThrow();
    expect(f.row()).toBeUndefined();
  });

  it("pauses the production connection handler and saves only encrypted personal configuration", async () => {
    const f = fixture();
    expect(await integrationTools.connect_app!(f.ctx, f.call)).toEqual({ paused: true });
    expect(f.pause.mock.calls[0]![0].blocks).toMatchObject([
      { input: "secret", integrationSetup: "personal-key-v1", status: "pending" },
    ]);
    await f.answer();
    expect(JSON.stringify(f.row())).not.toContain("fake-personal-key");
    expect(await f.personal.prepare("user", "composio")).toBeDefined();
    expect(await integrationTools.connect_app!(f.ctx, f.call)).toMatchObject({
      status: "connected",
    });
    expect(f.catalog).toHaveBeenCalled();
    expect(f.pause).toHaveBeenCalledOnce();
    expect(await f.personal.prepare("other", "composio")).toBeUndefined();
    expect(JSON.stringify(f.pause.mock.calls)).not.toContain("fake-personal-key");
  });
  it("keeps the ask retryable after failed validation", async () => {
    const f = fixture();
    await integrationTools.connect_app!(f.ctx, f.call);
    f.verify.mockRejectedValueOnce(new Error("fake-personal-key"));
    await expect(f.answer()).rejects.toThrow("Could not verify these credentials");
    expect(f.row()).toBeUndefined();
    await f.answer();
    expect(f.row()).toBeDefined();
  });
  it("denies another account and a changed Space before persistence", async () => {
    const f = fixture();
    await integrationTools.connect_app!(f.ctx, f.call);
    await expect(f.answer("other")).rejects.toThrow("Invalid protected answer");
    expect(f.verify).not.toHaveBeenCalled();
    await expect(f.answer("user", "other-space")).rejects.toThrow("Secret request changed");
    expect(f.row()).toBeUndefined();
  });
  it("refuses cancelled runs and replays dismissal without another card", async () => {
    const f = fixture();
    await integrationTools.connect_app!(f.ctx, f.call);
    f.cancel();
    await expect(f.answer()).rejects.toThrow("Secret request changed");
    effect.status = "completed";
    effect.result = { ok: false, dismissed: true };
    expect(await integrationTools.connect_app!(f.ctx, f.call)).toEqual(effect.result);
    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.row()).toBeUndefined();
  });

  it("asks for a replacement when the saved key is rejected and keeps the key out of the card", async () => {
    const f = fixture();
    expect(await integrationTools.connect_app!(f.ctx, f.call)).toEqual({ paused: true });
    await f.answer();
    f.verify.mockRejectedValueOnce(new Error("fake-personal-key rejected"));
    expect(await integrationTools.connect_app!(f.ctx, f.call)).toEqual({ paused: true });
    expect(f.pause.mock.calls.at(-1)![0].blocks).toMatchObject([
      {
        input: "secret",
        integrationSetup: "personal-key-v1",
        replacesIntegrationKey: true,
        status: "pending",
      },
    ]);
    expect(JSON.stringify(f.pause.mock.calls)).not.toContain("fake-personal-key");
    await f.answer();
    expect(f.prisma.userIntegrationProviderConfig.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not replace a saved key when the provider cannot be reached", async () => {
    const f = fixture();
    await integrationTools.connect_app!(f.ctx, f.call);
    await f.answer();
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    f.verify.mockRejectedValue(timeout);
    const outcome = await integrationTools.connect_app!(f.ctx, f.call).catch(
      (error: unknown) => error,
    );
    expect(outcome).not.toEqual({ paused: true });
    expect(f.pause).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.pause.mock.calls)).not.toContain("replacesIntegrationKey");
    expect(f.prisma.userIntegrationProviderConfig.upsert).toHaveBeenCalledTimes(1);
  });
});
