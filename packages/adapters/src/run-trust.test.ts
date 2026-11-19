import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  connectorTrustKeys,
  createRunTrustLoaders,
  ownerNamedConnectorTrustKeys,
} from "./run-trust.js";

describe("connectorTrustKeys", () => {
  const providers = ["gmail", "slack"];

  it("keys a batch by the app each action reaches", () => {
    expect(
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS", "SLACK_LIST_CHANNELS", "NOTION_SEARCH"],
        { connectorId: "composio" },
        "composio",
        providers,
      ),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack", "kind:composio:notion_search"]);
  });

  it("keeps the same action on two MCP servers apart", () => {
    const keys = (resourceId: string) =>
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS"],
        { connectorId: "mcp", resourceId },
        "mcp",
        providers,
      );
    expect(keys("server-a")).toEqual(["resource:mcp:server-a:gmail"]);
    expect(keys("server-b")).not.toEqual(keys("server-a"));
  });

  it("keys a call that is not a batch by its connection", () => {
    expect(
      connectorTrustKeys(undefined, { connectorId: "mcp", resourceId: "server-a" }, "mcp", []),
    ).toEqual(["resource:mcp:server-a"]);
  });
});

describe("ownerNamedConnectorTrustKeys", () => {
  const plugins = [
    { provider: "gmail", connectorId: "apps", displayName: "Gmail" },
    { provider: "googledrive", connectorId: "apps", displayName: "Google Drive" },
    { provider: "slack", connectorId: "apps", displayName: "Slack" },
  ];
  const routes = [
    { connectorId: "mcp", resourceId: "srv-linear", catalogGroup: "Linear (mcp; srv-linear)" },
    { connectorId: "mcp", resourceId: "srv-jira", catalogGroup: "Jira (mcp; srv-jira)" },
  ];

  it("trusts connected apps and MCP servers explicitly named in the owner's prompt", () => {
    const keys = ownerNamedConnectorTrustKeys(
      "Đọc Gmail rồi kiểm tra file trên Google Drive và cập nhật Linear giúp anh",
      plugins,
      routes,
    );
    expect(keys.has("kind:gmail")).toBe(true);
    expect(keys.has("kind:apps:gmail")).toBe(true);
    expect(keys.has("kind:googledrive")).toBe(true);
    expect(keys.has("kind:apps:googledrive")).toBe(true);
    expect(keys.has("resource:mcp:srv-linear")).toBe(true);
    // Unmentioned connectors remain untrusted to preserve prompt-injection boundaries.
    expect(keys.has("kind:slack")).toBe(false);
    expect(keys.has("kind:apps:slack")).toBe(false);
    expect(keys.has("resource:mcp:srv-jira")).toBe(false);
  });

  it("never matches substrings inside unrelated words or short labels", () => {
    const keys = ownerNamedConnectorTrustKeys(
      "Review the hard drive backup and mailbox summary",
      [...plugins, { provider: "go", connectorId: "apps", displayName: "Go" }],
      routes,
    );
    expect(keys.size).toBe(0);
  });

  it("does not seed connector trust for non-owner messaging runs", async () => {
    const trust = createRunTrustLoaders(
      {
        prisma: {
          externalEffect: { findMany: vi.fn(async () => []) },
        },
      } as unknown as ExecutorDeps,
      {
        run: { userId: "user", spaceId: "space", trigger: "messaging" },
        runId: "run",
        botId: "bot",
        taskPrompt: "Check Gmail and Google Drive",
        ownerStartedRun: false,
        messagingChannelRun: true,
        sourceMessage: {
          id: "msg-1",
          role: "user",
          blocks: [{ kind: "text", text: "Check Gmail and Google Drive" }],
        },
        connectedPlugins: plugins,
        connectorRoutes: routes,
      },
    );
    expect([...(await trust.loadTrustedConnectors())]).toEqual([]);
  });
});

describe("delegated authorization provenance", () => {
  const request = {
    trigger: "user",
    threadId: "chat",
    delegatedFromRunId: null,
    sourceMessage: {
      role: "user",
      authorUserId: "user",
      threadId: "chat",
      blocks: [{ kind: "text", text: "Compare the documents." }],
    },
  };
  function loaders(trigger: string, origin: string | null, rows: unknown[]) {
    const findFirst = vi.fn();
    for (const row of rows) findFirst.mockResolvedValueOnce(row);
    const trust = createRunTrustLoaders(
      {
        prisma: { run: { findFirst }, message: { findMany: vi.fn(async () => []) } },
      } as unknown as ExecutorDeps,
      {
        run: { userId: "user", spaceId: "space", trigger, delegatedFromRunId: origin },
        runId: "run",
        botId: "bot",
        taskPrompt: "Model-generated brief and instructions",
        ownerStartedRun: true,
        messagingChannelRun: false,
        sourceMessage: null,
        connectedPlugins: [],
      },
    );
    return { trust, findFirst };
  }
  it("recovers the initiating user's words for a helper result across restart", async () => {
    const { trust, findFirst } = loaders("helper_result", "helper", [
      { trigger: "helper", delegatedFromRunId: "parent" },
      request,
    ]);
    expect(await trust.loadOwnerWords()).toBe("Compare the documents.");
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "parent", userId: "user", spaceId: "space", botId: "bot" },
      }),
    );
  });
  it.each([
    null,
    { ...request, status: "cancelled" },
    {
      ...request,
      thread: { groupId: "group", group: { archivedAt: new Date(), members: [{ botId: "bot" }] } },
    },
    { ...request, thread: { groupId: "group", group: { archivedAt: null, members: [] } } },
    { ...request, sourceMessage: null },
    { ...request, sourceMessage: { ...request.sourceMessage, authorUserId: "another-user" } },
    { ...request, sourceMessage: { ...request.sourceMessage, role: "bot" } },
    { ...request, sourceMessage: { ...request.sourceMessage, threadId: "another-chat" } },
  ])("does not treat missing, foreign, or generated messages as permission", async (row) => {
    const { trust } = loaders("helper", "parent", [row]);
    expect(await trust.loadOwnerWords()).toBe("");
  });
  it("does not substitute the brief for helpers created by the previous release", async () => {
    const { trust, findFirst } = loaders("helper", null, []);
    expect(await trust.loadOwnerWords()).toBe("");
    expect(findFirst).not.toHaveBeenCalled();
  });
});
