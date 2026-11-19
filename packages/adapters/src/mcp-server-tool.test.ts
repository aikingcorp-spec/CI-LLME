import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import {
  addMcpServerFromTool,
  buildMcpCredentialBlob,
  deriveMcpSlug,
  formatStdioApprovalSummary,
  needsOAuthProbe,
  parseMcpServerToolArgs,
} from "./mcp-server-tool.js";

const persistMessageMock = vi.fn();

vi.mock("./run-messages.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-messages.js")>();
  return {
    ...actual,
    persistMessageInTransaction: (...args: unknown[]) => persistMessageMock(...args),
  };
});

beforeEach(() => {
  persistMessageMock.mockReset();
  persistMessageMock.mockResolvedValue({
    message: { id: "msg-1" },
    eventSeq: 42,
    firstResponseRunId: "run-1",
  });
});

describe("deriveMcpSlug", () => {
  it("slugifies server names like the settings overlay does", () => {
    expect(deriveMcpSlug("Brex MCP Server!")).toBe("brex-mcp-server");
    expect(deriveMcpSlug("  --  ")).toMatch(/^mcp-\d+$/);
    expect(deriveMcpSlug("x".repeat(100))).toHaveLength(64);
  });
});

describe("formatStdioApprovalSummary", () => {
  it("redacts values after secret flags, secret KEY=VALUE args, and token literals", () => {
    expect(
      formatStdioApprovalSummary("npx", [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/tmp",
        "--api-key",
        "supersecret",
        "--github-token=ghp_1234567890abcdef",
        "API_KEY=anothersecret",
        "sk-1234567890abcdef",
      ]),
    ).toBe(
      "npx -y @modelcontextprotocol/server-filesystem /tmp --api-key [REDACTED] --github-token=[REDACTED] API_KEY=[REDACTED] [REDACTED]",
    );
  });

  it("truncates summaries longer than 240 characters", () => {
    const longArg = "a".repeat(300);
    const summary = formatStdioApprovalSummary("node", [longArg]);
    expect(summary).toHaveLength(240);
    expect(summary.endsWith("...")).toBe(true);
  });
});

describe("parseMcpServerToolArgs", () => {
  it("parses a minimal remote server", () => {
    const parsed = parseMcpServerToolArgs({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
    });
    expect(parsed).toMatchObject({
      name: "Brex",
      transport: "streamable_http",
      endpoint: "https://api.brex.example/mcp",
      assignToSelf: true,
    });
    expect(parsed?.slug).toBe("brex");
  });

  it("rejects missing names, bad transports, and non-http endpoints", () => {
    expect(
      parseMcpServerToolArgs({ transport: "streamable_http", endpoint: "https://x.test" }),
    ).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "carrier-pigeon" })).toBeUndefined();
    expect(parseMcpServerToolArgs({ name: "x", transport: "streamable_http" })).toBeUndefined();
    expect(
      parseMcpServerToolArgs({ name: "x", transport: "streamable_http", endpoint: "ftp://x.test" }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "http://10.0.0.8/mcp",
      }),
    ).toMatchObject({ endpoint: "http://10.0.0.8/mcp" });
    expect(
      parseMcpServerToolArgs({
        name: "x",
        transport: "streamable_http",
        endpoint: "https://user:password@x.test/mcp#fragment",
      }),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs({ name: "x", transport: "stdio", command: "node" }),
    ).toBeUndefined();
  });

  it("parses stdio servers only when allowStdio is enabled and forces assignToSelf", () => {
    const parsed = parseMcpServerToolArgs(
      {
        name: "Local Files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        env: { WORKSPACE_MODE: "readonly" },
        assign_to_self: false,
      },
      { allowStdio: true },
    );
    expect(parsed).toEqual({
      slug: "local-files",
      name: "Local Files",
      description: "",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { WORKSPACE_MODE: "readonly" },
      headers: {},
      assignToSelf: true,
    });

    expect(
      parseMcpServerToolArgs(
        { name: "Bad Env", transport: "stdio", command: "node", env: { "BAD-KEY": "1" } },
        { allowStdio: true },
      ),
    ).toBeUndefined();
    expect(
      parseMcpServerToolArgs(
        { name: "Bad Args", transport: "stdio", command: "node", args: [123] },
        { allowStdio: true },
      ),
    ).toBeUndefined();
  });

  it("keeps only string-valued headers and caps their count", () => {
    const parsed = parseMcpServerToolArgs({
      name: "H",
      transport: "sse",
      endpoint: "https://h.example.test",
      headers: { Authorization: "Bearer t", Broken: 42 as unknown as string },
    });
    expect(parsed?.headers).toEqual({ Authorization: "Bearer t" });

    const tooMany = parseMcpServerToolArgs({
      name: "H",
      transport: "sse",
      endpoint: "https://h.example.test",
      headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, "v"])),
    });
    expect(tooMany).toBeUndefined();
  });
});

describe("addMcpServerFromTool", () => {
  const run = {
    id: "run-1",
    spaceId: "space-1",
    userId: "user-1",
    threadId: "t-1",
    botId: "b-1",
  };

  it("never adds a local (stdio) server when stdio is not enabled by policy", async () => {
    const create = vi.fn();
    const result = await addMcpServerFromTool(
      {
        prisma: { mcpServer: { create }, $transaction: create },
      } as unknown as ExecutorDeps,
      run,
      "b-1",
      { name: "Local", transport: "stdio", command: "node", args: ["-e", "1"] },
      "exec-1",
    );
    expect(result).toEqual({
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a guarded stdio server with encrypted args/env and a redacted chat approval card", async () => {
    const secretCreate = vi.fn();
    const serverCreate = vi.fn().mockResolvedValue({ id: "srv-1", name: "Filesystem" });
    const notify = vi.fn().mockResolvedValue(undefined);
    const putSecret = vi.fn().mockResolvedValue({ id: "sec-1", ciphertext: "enc-blob" });
    const deps = {
      mcpStdioPolicy: { stdioEnabled: true, allowedCommands: ["npx", "node"] },
      secretStore: { put: putSecret },
      events: { notify },
      prisma: {
        $transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
          fn({
            secret: { create: secretCreate },
            mcpServer: { create: serverCreate },
          }),
      },
    } as unknown as ExecutorDeps;

    const result = await addMcpServerFromTool(
      deps,
      run,
      "b-1",
      {
        name: "Filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp", "--api-key", "supersecret"],
        env: { API_TOKEN: "envsecret" },
        assign_to_self: false,
      },
      "exec-1",
    );

    expect(result).toMatchObject({ ok: true, server_id: "srv-1" });
    expect(putSecret).toHaveBeenCalledOnce();
    expect(JSON.parse(putSecret.mock.calls[0]![0] as string)).toEqual({
      env: { API_TOKEN: "envsecret" },
      headers: {},
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp", "--api-key", "supersecret"],
    });
    expect(secretCreate).toHaveBeenCalledWith({
      data: {
        id: "sec-1",
        userId: "user-1",
        spaceId: "space-1",
        kind: "mcp",
        ciphertext: "enc-blob",
      },
    });
    expect(serverCreate).toHaveBeenCalledWith({
      data: {
        spaceId: "space-1",
        userId: "user-1",
        slug: "filesystem",
        name: "Filesystem",
        description: "",
        transport: "stdio",
        endpoint: null,
        command: "npx",
        hasArgs: true,
        env: { API_TOKEN: true },
        headers: {},
        secretId: "sec-1",
        enabled: true,
      },
    });
    expect(persistMessageMock).toHaveBeenCalledOnce();
    const blocks = persistMessageMock.mock.calls[0]![3] as Array<Record<string, unknown>>;
    expect(blocks).toEqual([
      {
        kind: "mcp_approval",
        name: "Filesystem",
        serverId: "srv-1",
        transport: "stdio",
        endpoint: "npx -y @modelcontextprotocol/server-filesystem /tmp --api-key [REDACTED]",
        needsOAuth: false,
        status: "pending",
      },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("supersecret");
    expect(JSON.stringify(blocks)).not.toContain("envsecret");
    expect(notify).toHaveBeenCalledWith("t-1", 42, "run-1");
  });

  it("refuses disallowed stdio commands and invalid npx specs", async () => {
    const tx = vi.fn();
    const deps = {
      mcpStdioPolicy: { stdioEnabled: true, allowedCommands: ["npx", "node"] },
      secretStore: { put: vi.fn() },
      prisma: { $transaction: tx },
    } as unknown as ExecutorDeps;

    expect(
      await addMcpServerFromTool(
        deps,
        run,
        "b-1",
        { name: "Shell", transport: "stdio", command: "bash", args: ["-c", "id"] },
        "exec-1",
      ),
    ).toEqual({ error: "This stdio command isn't allowed here" });

    expect(
      await addMcpServerFromTool(
        deps,
        run,
        "b-1",
        { name: "Runner", transport: "stdio", command: "uvx", args: ["mcp-server"] },
        "exec-1",
      ),
    ).toEqual({ error: "This stdio command isn't allowed here" });

    expect(
      await addMcpServerFromTool(
        deps,
        run,
        "b-1",
        { name: "BadNpx", transport: "stdio", command: "npx", args: ["./local-script.js"] },
        "exec-1",
      ),
    ).toEqual({
      error:
        'Invalid npx MCP launch arguments. Use a plain npm registry package such as ["-y", "@scope/mcp-server"].',
    });

    expect(tx).not.toHaveBeenCalled();
  });

  it("refuses a credential in the endpoint query, which would be stored in plaintext", async () => {
    const result = await addMcpServerFromTool(
      { mcpAllowPrivateEndpoint: true } as ExecutorDeps,
      run,
      "b-1",
      { name: "Brex", transport: "streamable_http", endpoint: "http://localhost/mcp?token=abc" },
      "exec-1",
    );
    expect(result).toEqual({ error: "Put token in a header instead of the server URL" });
  });
});

describe("buildMcpCredentialBlob", () => {
  it("returns null when no credential material exists", () => {
    expect(buildMcpCredentialBlob({})).toBeNull();
    expect(buildMcpCredentialBlob({ headers: {}, env: {} })).toBeNull();
  });

  it("serializes secret, env, and headers into the encrypted blob shape", () => {
    expect(
      buildMcpCredentialBlob({ secret: "tok", headers: { Authorization: "Bearer tok" }, env: {} }),
    ).toEqual(JSON.stringify({ secret: "tok", env: {}, headers: { Authorization: "Bearer tok" } }));
  });

  it("stores stdio arguments, which may carry tokens, in the blob", () => {
    expect(
      JSON.parse(buildMcpCredentialBlob({ args: ["--api-key", "fake-key"] }) ?? "null"),
    ).toEqual({ env: {}, headers: {}, args: ["--api-key", "fake-key"] });
    expect(buildMcpCredentialBlob({ args: [] })).toBeNull();
  });

  it("stores a pre-registered OAuth client on its own", () => {
    expect(
      JSON.parse(
        buildMcpCredentialBlob({
          headers: {},
          oauthClient: { clientId: "client-1", clientSecret: "client-secret" },
        }) ?? "null",
      ),
    ).toEqual({
      env: {},
      headers: {},
      oauthClient: { client_id: "client-1", client_secret: "client-secret" },
    });
    expect(
      JSON.parse(buildMcpCredentialBlob({ oauthClient: { clientId: "public-client" } }) ?? "null"),
    ).toMatchObject({ oauthClient: { client_id: "public-client" } });
  });
});

describe("buildMcpCredentialBlob credential files", () => {
  const files = { CREDENTIALS_PATH: '{"refresh_token":"{{oauth.refresh_token}}"}' };

  it("stores file templates, which may hold secrets, in the blob", () => {
    expect(JSON.parse(buildMcpCredentialBlob({ files }) ?? "null")).toEqual({
      env: {},
      headers: {},
      files,
    });
  });

  it("leaves the files out when there are none", () => {
    expect(buildMcpCredentialBlob({ files: {} })).toBeNull();
    expect(JSON.parse(buildMcpCredentialBlob({ secret: "tok", files: {} }) ?? "null")).toEqual({
      secret: "tok",
      env: {},
      headers: {},
    });
  });
});

describe("buildMcpCredentialBlob OAuth client options", () => {
  it("stores the scope and the normalized authorization server when given", () => {
    expect(
      JSON.parse(
        buildMcpCredentialBlob({
          env: { TOKEN: "{{oauth.access_token}}" },
          oauthClient: {
            clientId: "client-1",
            scope: "mail.read mail.send",
            authorizationServer: "https://accounts.example.test",
          },
        }) ?? "null",
      ),
    ).toMatchObject({
      oauthClient: {
        client_id: "client-1",
        scope: "mail.read mail.send",
        authorization_server: "https://accounts.example.test/",
      },
    });
  });

  it("leaves out an empty scope and a missing authorization server", () => {
    const blob = JSON.parse(
      buildMcpCredentialBlob({ oauthClient: { clientId: "client-1", scope: "" } }) ?? "null",
    );
    expect(blob.oauthClient).toEqual({ client_id: "client-1" });
  });
});

describe("needsOAuthProbe", () => {
  it("is true only for remote servers without static credentials", () => {
    expect(needsOAuthProbe({ transport: "streamable_http" })).toBe(true);
    expect(needsOAuthProbe({ transport: "sse" })).toBe(true);
    expect(needsOAuthProbe({ transport: "streamable_http", secret: "tok" })).toBe(false);
    expect(needsOAuthProbe({ transport: "streamable_http", headers: { Authorization: "x" } })).toBe(
      false,
    );
    expect(needsOAuthProbe({ transport: "stdio", command: "c" } as never)).toBe(false);
  });
});

describe("buildMcpCredentialBlob authorization parameters", () => {
  it("stores the client's extra authorization parameters", () => {
    expect(
      JSON.parse(
        buildMcpCredentialBlob({
          oauthClient: { clientId: "c", authorizationParams: "access_type=offline" },
        }) ?? "null",
      ),
    ).toMatchObject({
      oauthClient: { client_id: "c", authorization_params: "access_type=offline" },
    });
  });
});
