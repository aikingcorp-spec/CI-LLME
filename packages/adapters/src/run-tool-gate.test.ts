import type * as Core from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { recordAuditEvent } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordEffect } from "./run-effects.js";
import { gateToolCall } from "./run-tool-gate.js";
import type { ToolRequest } from "./run-tool-request.js";

const plans = vi.hoisted(() => [] as string[]);
const autoReviewSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    review: vi.fn(async () => ({ decision: "ask" as const, reason: "Review.", model: "judge" })),
  })),
);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect a person answers is where an ask begins; the test stops there.
vi.mock("./run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("asks the user");
  }),
}));
vi.mock("./run-auto-review.js", () => ({
  autoReviewCheckerProvider: autoReviewSpy,
}));

const loginUse = {
  kind: "login" as const,
  login: "work",
  site: "https://login.example.test",
  title: "login.example.test",
  fields: ["Password"],
  savedAt: "2026-09-01T00:00:01.000Z",
};

function gate(options: {
  trigger?: string;
  neverAsk?: boolean;
  rule?: "always_allow" | "deny";
  asks?: boolean;
}) {
  const args = { actions: [{ kind: "fill_secret", ref: "e1", secret: "work", field: "Password" }] };
  const executionId = JSON.stringify(["pi-tool", "main", "call-1"]);
  const request: ToolRequest = {
    name: "browser_act",
    args,
    executionId,
    connectorCall: { tool: "browser_act", args, executionId, route: undefined },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "browser_act",
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    loginUse: options.asks === false ? undefined : loginUse,
  };
  const ctx = {
    deps: { prisma: {} },
    run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: options.trigger ?? "user" },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true },
    tools: { connector: new Map(), connectedPlugins: [] },
    state: {
      tainted: false,
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () =>
        options.rule
          ? [{ effect: options.rule, matchKind: "tool", matchValue: "browser_act" }]
          : [],
      loadAutoReviewPreference: async () => ({
        enabled: false,
        skipApprovals: Boolean(options.neverAsk),
      }),
    },
  };
  return gateToolCall(ctx as never, request, undefined).then(
    (outcome) => outcome,
    (error: Error) => error.message,
  );
}

describe("gateToolCall: a login that asks first", () => {
  beforeEach(() => {
    plans.length = 0;
  });

  it("asks the user every time, in Never ask and over an Always allow rule", async () => {
    for (const options of [{}, { neverAsk: true }, { rule: "always_allow" as const }]) {
      plans.length = 0;
      expect(await gate(options)).toBe("asks the user");
      expect(plans).toEqual(["ask"]);
    }
    // The same call without such a login runs in Never ask, without asking.
    plans.length = 0;
    await gate({ neverAsk: true, asks: false });
    expect(plans).toEqual(["allow"]);
  });

  it("is refused by a rule that blocks the tool, and in a webhook run, as a card is", async () => {
    expect(await gate({ rule: "deny" })).toEqual({
      result: { error: expect.stringContaining("is blocked in this space") },
    });
    expect(await gate({ trigger: "webhook" })).toEqual({
      result: { error: expect.stringContaining("a webhook run cannot ask") },
    });
    expect(recordAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "denied", metadata: { reason: "login_unattended" } }),
    );
  });
});

describe("gateToolCall: checkerConfigured for deployment auto-review defaults", () => {
  beforeEach(() => {
    plans.length = 0;
    autoReviewSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects an openai-compatible deployment checker using its modelId and supports hosted credits", async () => {
    const executionId = JSON.stringify(["pi-tool", "main", "call-compat"]);
    const args = { to: "a@example.test", subject: "Hi", body: "Hello" };
    const request: ToolRequest = {
      name: "demo_send_email",
      args,
      executionId,
      connectorCall: { tool: "demo_send_email", args, executionId, route: undefined },
      effectRequest: args,
      resolvedTool: undefined,
      catalogRemapped: false,
      nextApprovedTool: undefined,
      approvedEffectKey: undefined,
      replayEffectToolName: "demo_send_email",
      fleetSummary: undefined,
      heldForApproval: false,
      purchase: undefined,
      cardUse: undefined,
      loginUse: undefined,
    };

    const compatCred = {
      id: "cred-compat-judge",
      userId: "user-1",
      provider: "openai-compatible",
      label: "Local Judge",
      secretId: "secret-judge",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const otherCred = {
      id: "cred-compat-other",
      userId: "user-1",
      provider: "openai-compatible",
      label: "Other",
      secretId: "secret-other",
      createdAt: new Date(1),
      updatedAt: new Date(1),
    };

    const runCompatGate = (creditsEnabled: boolean) => {
      vi.mocked(recordEffect).mockResolvedValueOnce({
        duplicate: false,
        effect: { id: "effect-1", status: "intended" },
      } as never);
      const ctx = {
        deps: {
          prisma: {
            externalEffect: {
              findMany: vi.fn(async () => []),
              update: vi.fn(async () => ({})),
            },
            space: {
              findFirst: vi.fn(async () =>
                creditsEnabled ? { organization: { modelCredits: { mode: "credits" } } } : null,
              ),
            },
            userModelCredential: {
              findMany: vi.fn(async () => (creditsEnabled ? [] : [otherCred, compatCred])),
              findFirst: vi.fn(async () => null),
            },
            userModelPreference: { findMany: vi.fn(async () => []) },
            secret: {
              findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
                id: where.id,
                ciphertext: where.id,
              })),
            },
          },
          secretStore: {
            load: vi.fn(async (cipher: string) =>
              JSON.stringify({
                kind: "openai_compatible",
                baseUrl: "http://127.0.0.1:11434/v1",
                enabledModelIds: cipher === "secret-judge" ? ["judge-model"] : ["other-model"],
              }),
            ),
          },
        },
        run: { id: "run-1", userId: "user-1", spaceId: "space-1", trigger: "user" },
        runId: "run-1",
        bot: { id: "bot-1", name: "Helper", description: "" },
        thread: { id: "thread-1" },
        task: { prompt: "Send email" },
        secrets: [],
        context: { signal: new AbortController().signal },
        source: { ownerStartedRun: true },
        tools: {
          connector: new Map([
            ["demo_send_email", { declaredReadOnly: false, toolName: "demo_send_email" }],
          ]),
          connectedPlugins: [],
        },
        state: {
          tainted: false,
          effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
        },
        trust: {
          loadApprovalRules: async () => [],
          loadAutoReviewPreference: async () => ({ enabled: true, skipApprovals: false }),
          loadApprovalModel: async () => ({
            primary: {
              provider: creditsEnabled ? "openrouter" : "openai-compatible",
              modelId: creditsEnabled ? "openai/gpt-4o-mini" : "judge-model",
            },
            backups: [],
            primarySource: "deployment",
          }),
          loadOwnerWords: async () => "",
        },
      };
      return gateToolCall(ctx as never, request, undefined).catch((error: Error) => error.message);
    };

    // Connection selecting: finds cred-compat-judge matching "judge-model" and plans "judge".
    await runCompatGate(false);
    expect(plans).toEqual(["judge"]);
    expect(autoReviewSpy).toHaveBeenCalledTimes(1);

    // Hosted credits fallback: plans "judge" even when no userModelCredential exists.
    plans.length = 0;
    autoReviewSpy.mockClear();
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "fake-hosted-key");
    await runCompatGate(true);
    expect(plans).toEqual(["judge"]);
    expect(autoReviewSpy).toHaveBeenCalledTimes(1);
  });
});
