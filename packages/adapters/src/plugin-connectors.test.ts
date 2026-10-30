import { describe, expect, it, vi } from "vitest";
import type { PluginRepoFile } from "./plugin-connectors.js";
import {
  classifyPluginFiles,
  fetchGitHubRepo,
  isTransientFetchError,
  parsePluginDirectory,
  parsePluginSource,
  pluginPreviewDto,
  previewPluginInstall,
} from "./plugin-connectors.js";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const schema = "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json";
const manifest = {
  $schema: schema,
  name: "example-plugin",
  version: "1.0.0",
  description: "Example",
};
const skill = "---\nname: example-skill\ndescription: Example skill\n---\n\nFollow these steps.\n";
function files(
  mcpServers: Record<string, unknown> = {
    remote: { type: "streamable-http", url: "https://tools.example.test/mcp" },
  },
): PluginRepoFile[] {
  return [
    { path: "plugin.json", content: JSON.stringify(manifest) },
    { path: "skills/example-skill/SKILL.md", content: skill },
    {
      path: "mcp.json",
      content: JSON.stringify({
        $schema: schema.replace("plugin.schema", "mcp.schema"),
        mcpServers,
      }),
    },
  ];
}
const parse = (input = files()) => parsePluginDirectory({ files: input, resolvedSha: SHA });

describe("plugin sources", () => {
  it.each([
    ["https://github.com/example/plugins", { gitUrl: "https://github.com/example/plugins" }],
    ["https://github.com/Example/Plugins", { gitUrl: "https://github.com/example/plugins" }],
    [
      "https://github.com/example/plugins.git@feature/plugins#one",
      { gitUrl: "https://github.com/example/plugins", ref: "feature/plugins", subdir: "one" },
    ],
    [
      "https://github.com/example/plugins/tree/main/one",
      { gitUrl: "https://github.com/example/plugins", ref: "main", subdir: "one" },
    ],
  ])("normalizes %s", (source, expected) => expect(parsePluginSource(source)).toEqual(expected));
  it.each([
    "http://github.com/a/b",
    "https://user:password@github.com/a/b",
    "https://github.com/a/b?token=secret",
    "https://github.com/a/b#../escape",
    "https://github.com/a/b#dir\\file",
    "https://github.com/a/b#%2e%2e/escape",
    "https://github.com/a/b#one#two",
    "not a url",
    "https://github.com:444/a/b",
  ])("rejects unsafe source %s", (source) => expect(() => parsePluginSource(source)).toThrow());
});

describe("portable plugin parser", () => {
  it.each(["1.0.0", "1.1.0"])("loads Agent Plugins %s skills and remote MCP", (version) => {
    const entries = files().map((file) => ({
      ...file,
      content: file.content.replaceAll("1.1.0", version),
    }));
    const preview = parse(entries);
    expect(preview).toMatchObject({
      format: "agent-plugins",
      name: "example-plugin",
      resolvedSha: SHA,
    });
    expect(preview.skills).toEqual([
      { name: "example-skill", description: "Example skill", content: skill },
    ]);
    expect(preview.mcpServers).toEqual([
      {
        name: "remote",
        transport: "streamable_http",
        endpoint: "https://tools.example.test/mcp",
        headers: {},
      },
    ]);
  });
  it.each([
    [".cursor-plugin/plugin.json", "cursor"],
    [".grok-plugin/plugin.json", "grok"],
  ])("loads legacy %s and http alias", (path, format) => {
    const preview = parse([
      { path, content: JSON.stringify({ name: "example-plugin", skills: "./skills/" }) },
      {
        path: ".mcp.json",
        content: JSON.stringify({
          mcpServers: { remote: { type: "http", url: "https://example.test/mcp" } },
        }),
      },
    ]);
    expect(preview.format).toBe(format);
    expect(preview.mcpServers[0]?.transport).toBe("streamable_http");
  });
  it("keeps loading valid components when siblings are invalid, local or editor-only", () => {
    const preview = parse([
      ...files({
        good: { type: "sse", url: "https://example.test/sse" },
        local: { type: "stdio", command: "sh", args: ["malicious.sh"] },
        invalid: { type: "sse", url: "https://user:password@example.test/" },
        unknown: { type: "other" },
      }),
      { path: "skills/bad/SKILL.md", content: "No frontmatter" },
      { path: "hooks/hook.sh", content: "do not run" },
    ]);
    expect(preview.skills).toHaveLength(1);
    expect(preview.mcpServers.map((s) => s.name)).toEqual(["good"]);
    expect(preview.skipped.map((s) => s.kind)).toEqual(
      expect.arrayContaining([
        "mcp_stdio",
        "mcp_invalid",
        "unsupported_transport",
        "skill_invalid",
        "editor_only",
      ]),
    );
  });
  it("installs sub-agents and commands as skills, and skips only editor parts", () => {
    const preview = parse([
      ...files(),
      {
        path: "agents/reviewer.md",
        content:
          "---\nname: reviewer\ndescription: Reviews changes\nmodel: inherit\n---\n\nCheck the diff.\n",
      },
      {
        path: "commands/deploy.md",
        content: "---\ndescription: Deploy the project\n---\n\nDeploy to $ARGUMENTS.\n",
      },
      { path: "commands/status.md", content: "# Show status\n\nPrint the status.\n" },
      { path: "commands/_conventions.md", content: "Shared notes" },
      { path: "commands/example-skill.md", content: "Repeats the skill" },
      { path: ".lsp.json", content: "{}" },
    ]);
    const byName = Object.fromEntries(preview.skills.map((s) => [s.name, s]));
    expect(Object.keys(byName)).toEqual(["deploy", "example-skill", "reviewer", "status"]);
    expect(byName.reviewer?.content).toContain('call run_subagent with name "reviewer"');
    expect(byName.reviewer?.content).toContain("Check the diff.");
    expect(byName.deploy?.description).toBe("Deploy the project");
    expect(byName.deploy?.content).toContain("$ARGUMENTS is whatever the user wrote after /deploy");
    expect(byName.status?.description).toBe("Show status");
    expect(preview.skipped).toEqual([
      { kind: "editor_only", name: ".lsp.json", reason: "Runs only inside an editor" },
    ]);
  });
  it("skips an invalid command without blocking the rest of the plugin", () => {
    const preview = parse([
      ...files(),
      { path: `commands/${"x".repeat(81)}.md`, content: "# Too long\n\nBody.\n" },
    ]);
    expect(preview.skills.map((s) => s.name)).toEqual(["example-skill"]);
    expect(preview.skipped).toContainEqual(
      expect.objectContaining({ kind: "skill_invalid", name: `commands/${"x".repeat(81)}.md` }),
    );
  });
  it("tells from a file list whether every part installs", () => {
    const remote = JSON.stringify({
      mcpServers: { tools: { type: "http", url: "https://tools.example.test/mcp" } },
    });
    expect(
      classifyPluginFiles(["mcp.json", "skills/a/SKILL.md", "agents/b.md", "README.md"], remote),
    ).toEqual({ hasConnector: true, skillCount: 2 });
    expect(classifyPluginFiles(["skills/a/SKILL.md", "hooks/hooks.json"])).toBe("incomplete");
    expect(classifyPluginFiles(["skills/a/SKILL.md", "skills/a/references/notes.md"])).toEqual({
      hasConnector: false,
      skillCount: 1,
    });
    expect(classifyPluginFiles(["skills/a/SKILL.md", "skills/a/run.sh"])).toBe("incomplete");
    expect(classifyPluginFiles(["mcp.json"])).toBeNull();
    expect(
      classifyPluginFiles(["mcp.json"], JSON.stringify({ mcpServers: { x: { command: "npx" } } })),
    ).toBe("incomplete");
    expect(classifyPluginFiles(["README.md"])).toBe("incomplete");
    const refs = Array.from({ length: 5 }, (_, i) => `skills/a/references/r${i}.md`);
    const big = new Map(refs.map((path) => [path, 90_000] as const));
    expect(classifyPluginFiles(["skills/a/SKILL.md", ...refs], undefined, big)).toBe("incomplete");
    expect(
      classifyPluginFiles(
        ["skills/a/SKILL.md", refs[0]!],
        undefined,
        new Map([[refs[0]!, 120_000]]),
      ),
    ).toBe("incomplete");
    const manySkills = Array.from({ length: 5 }, (_, s) => [
      `skills/s${s}/SKILL.md`,
      ...Array.from({ length: 40 }, (_, r) => `skills/s${s}/references/r${r}.md`),
    ]).flat();
    expect(classifyPluginFiles(manySkills)).toBe("incomplete");
    expect(classifyPluginFiles(["skills/a/SKILL.md", refs[0]!], undefined, big)).toEqual({
      hasConnector: false,
      skillCount: 1,
    });
  });
  it("rejects unknown manifest versions/invalid metadata; reports unknown fields", () => {
    expect(() =>
      parse([{ path: "plugin.json", content: JSON.stringify({ name: "example" }) }]),
    ).toThrow(/schema/);
    expect(() =>
      parse([{ path: "plugin.json", content: JSON.stringify({ ...manifest, name: "Bad Name" }) }]),
    ).toThrow(/metadata/);
    const result = parse([
      { path: "plugin.json", content: JSON.stringify({ ...manifest, custom: true }) },
    ]);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({ kind: "unsupported_field", name: "custom" }),
    );
  });
  it("disables only MCP on schema mismatch or unknown top-level fields", () => {
    for (const config of [
      { $schema: "unknown", mcpServers: {} },
      { $schema: schema.replace("plugin.schema", "mcp.schema"), mcpServers: {}, extra: true },
    ]) {
      const preview = parse(
        files().map((f) => (f.path === "mcp.json" ? { ...f, content: JSON.stringify(config) } : f)),
      );
      expect(preview.skills).toHaveLength(1);
      expect(preview.mcpServers).toEqual([]);
      expect(preview.skipped[0]?.kind).toBe("mcp_invalid");
    }
  });
  it("keeps text reference files with their skill", () => {
    const preview = parse([
      ...files(),
      { path: "skills/example-skill/references/guide.md", content: "guide" },
      { path: "skills/example-skill/data/rates.csv", content: "a,b" },
    ]);
    expect(preview.skills).toEqual([
      expect.objectContaining({
        name: "example-skill",
        files: { "references/guide.md": "guide", "data/rates.csv": "a,b" },
      }),
    ]);
    expect(preview.skipped).toEqual([]);
  });
  it("does not install a skill whose scripts would be missing", () => {
    const preview = parse([
      ...files(),
      { path: "skills/nested/deeper/SKILL.md", content: skill },
      { path: "skills/example-skill/scripts/run.py", content: "" },
    ]);
    expect(preview.skills).toEqual([]);
    expect(preview.skipped[0]?.reason).toMatch(/scripts/);
  });
  it("refuses a skill whose reference files exceed the caps", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({
      path: `skills/example-skill/references/${i}.md`,
      content: "x",
    }));
    expect(parse([...files(), ...many]).skills).toEqual([]);
    const big = Array.from({ length: 5 }, (_, i) => ({
      path: `skills/example-skill/references/big-${i}.md`,
      content: "x".repeat(90_000),
    }));
    expect(parse([...files(), ...big]).skipped[0]?.reason).toMatch(/too large/);
  });
  it.each(["../plugin.json", "/plugin.json", "skills/../plugin.json", "dir\\plugin.json"])(
    "rejects escaping path %s",
    (path) => {
      expect(() => parse([{ path, content: "{}" }])).toThrow(/paths/);
    },
  );
  it("bounds file count and file size, rejects duplicate paths/names", () => {
    expect(() =>
      parse(Array.from({ length: 5001 }, (_, i) => ({ path: `${i}`, content: "" }))),
    ).toThrow(/too many/);
    expect(() => parse([{ path: "plugin.json", content: "a".repeat(100_001) }])).toThrow(
      /too large/,
    );
    expect(() => parse([...files(), files()[0]!])).toThrow(/duplicate file/);
    expect(() => parse([...files(), { path: "skills/second/SKILL.md", content: skill }])).toThrow(
      /duplicate skill/,
    );
  });
  it("digests all manifest and component content independent of listing order", () => {
    const original = parse();
    expect(parse(files().reverse()).digest).toBe(original.digest);
    expect(parse(files().map((f) => ({ ...f, content: `${f.content}\n` }))).digest).not.toBe(
      original.digest,
    );
  });
  it("hides headers and skill bodies in public previews", () => {
    const preview = parse(
      files({
        remote: {
          type: "streamable-http",
          url: "https://example.test/mcp",
          headers: { "X-Tenant": "package-tenant" },
        },
      }),
    );
    const dto = pluginPreviewDto(preview);
    expect(JSON.stringify(dto)).not.toContain("package-tenant");
    expect(JSON.stringify(dto)).not.toContain("Follow these steps");
    expect(dto.mcpServers[0]?.staticHeaderKeys).toEqual(["X-Tenant"]);
  });
  it.each([
    { type: "sse", url: "https://example.test/mcp?api_key=fake-secret" },
    { type: "sse", url: "https://example.test/mcp", headers: { "X-Test": "injected\r\nheader" } },
    { type: "sse", url: "https://example.test/mcp", headers: { "X-Test": "one", "x-test": "two" } },
  ])("rejects unsafe queries or headers %j", (server) => {
    expect(parse(files({ remote: server })).mcpServers).toEqual([]);
  });

  it("skips unresolved legacy credential placeholders rather than leaking/substituting", () => {
    expect(
      parse(
        files({
          remote: {
            type: "sse",
            url: "https://example.test/mcp",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal untrusted plugin placeholder fixture
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        }),
      ).mcpServers,
    ).toEqual([]);
  });
});

describe("GitHub acquisition", () => {
  function reader(
    entries: Array<Record<string, unknown>> = [
      { path: "plugin.json", type: "blob", mode: "100644", size: 80 },
    ],
  ) {
    return vi.fn(async (url: string) => {
      if (url.includes("/commits/"))
        return JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } });
      if (url.includes("/git/trees/")) return JSON.stringify({ tree: entries, truncated: false });
      return JSON.stringify(manifest);
    });
  }
  it("retries one stalled GitHub request instead of failing the preview", async () => {
    const inner = reader();
    let stalled = false;
    const read = vi.fn(async (url: string, _max: number, _signal?: AbortSignal) => {
      if (!stalled && url.includes("raw.githubusercontent.com")) {
        stalled = true;
        throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
      }
      return inner(url);
    });
    const repo = await fetchGitHubRepo(
      parsePluginSource("https://github.com/example/plugin@main"),
      undefined,
      read,
    );
    expect(repo.resolvedSha).toBe(SHA);
    expect(read.mock.calls.filter(([url]) => url.includes("raw.githubusercontent")).length).toBe(2);
  });
  it("sends GITHUB_TOKEN only to the GitHub API, never to raw file hosts", async () => {
    const read = reader();
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    try {
      await fetchGitHubRepo(
        parsePluginSource("https://github.com/example/plugin@main"),
        undefined,
        read,
      );
    } finally {
      vi.unstubAllEnvs();
    }
    for (const [url, , , headers] of read.mock.calls as unknown as Array<
      [string, number, AbortSignal, Record<string, string> | undefined]
    >) {
      if (url.startsWith("https://api.github.com/"))
        expect(headers?.authorization).toBe("Bearer test-token");
      else expect(headers?.authorization).toBeUndefined();
    }
  });
  it("previews without a token and does not send authorization", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const read = reader();
    try {
      await fetchGitHubRepo(
        parsePluginSource("https://github.com/example/plugin@main"),
        undefined,
        read,
      );
      for (const call of read.mock.calls) {
        expect(
          (call as unknown as [string, number, AbortSignal, Record<string, string>])[3]
            ?.authorization,
        ).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([403, 429])("reports the unauthenticated GitHub quota for HTTP %s", async (status) => {
    vi.stubEnv("GITHUB_TOKEN", "");
    try {
      const read = vi.fn(async () => {
        throw new Error(`Request failed: HTTP ${status}`);
      });
      await expect(
        fetchGitHubRepo(
          parsePluginSource("https://github.com/example/plugin@main"),
          undefined,
          read,
        ),
      ).rejects.toThrow(/HTTP 429.*unauthenticated.*60\/hour.*optionally set GITHUB_TOKEN/);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("fetches and parses the VNBot manifest", async () => {
    const read = reader([
      { path: ".vnbot-plugin/plugin.json", type: "blob", mode: "100644", size: 80 },
    ]);
    const repo = await fetchGitHubRepo(
      parsePluginSource("https://github.com/example/plugin"),
      undefined,
      read,
    );
    expect(repo.files.map((file) => file.path)).toEqual([".vnbot-plugin/plugin.json"]);
    expect(parsePluginDirectory(repo)).toMatchObject({
      name: "example-plugin",
      format: "agent-plugins",
    });
  });
  it("resolves once then fetches an immutable tree and raw files", async () => {
    const read = reader();
    const repo = await fetchGitHubRepo(
      parsePluginSource("https://github.com/example/plugin@main"),
      undefined,
      read,
    );
    expect(repo.resolvedSha).toBe(SHA);
    expect(read.mock.calls.map((c) => c[0])).toEqual([
      "https://api.github.com/repos/example/plugin/commits/main",
      `https://api.github.com/repos/example/plugin/git/trees/${TREE}?recursive=1`,
      `https://raw.githubusercontent.com/example/plugin/${SHA}/plugin.json`,
    ]);
  });
  it("never follows links or submodules, and refuses only a skill that contains one", async () => {
    const tree = [
      { path: "plugin.json", type: "blob", mode: "100644", size: 80 },
      { path: "skills/kept/SKILL.md", type: "blob", mode: "100644", size: 80 },
      { path: "skills/linked/SKILL.md", type: "blob", mode: "100644", size: 80 },
      { path: "skills/linked/references/notes.md", mode: "120000", type: "blob" },
      { path: "docs", mode: "160000", type: "commit" },
    ];
    const read = vi.fn(async (url: string) => {
      if (url.includes("/commits/"))
        return JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } });
      if (url.includes("/git/trees/")) return JSON.stringify({ tree, truncated: false });
      const name = /skills\/([^/]+)\/SKILL\.md$/.exec(url)?.[1];
      return name
        ? `---\nname: ${name}\ndescription: Example\n---\n\nSteps.\n`
        : JSON.stringify(manifest);
    });
    const repo = await fetchGitHubRepo(
      parsePluginSource("https://github.com/example/plugin"),
      undefined,
      read,
    );
    expect(read.mock.calls.map((c) => c[0]).join(" ")).not.toContain("notes.md");
    expect(repo.files.map((f) => f.path)).toEqual([...repo.files.map((f) => f.path)].sort());
    const preview = parsePluginDirectory(repo);
    expect(preview.skills.map((s) => s.name)).toEqual(["kept"]);
    expect(preview.skipped).toContainEqual(
      expect.objectContaining({ reason: "Skills with links or submodules are not supported" }),
    );
  });
  it("reports a skill folder that is a link instead of ignoring it", () => {
    const preview = parse([...files(), { path: "skills/linked", content: "\u0001" }]);
    expect(preview.skipped).toContainEqual(
      expect.objectContaining({
        name: "skills/linked",
        reason: "Links and submodules are not supported",
      }),
    );
  });
  it("tells temporary fetch failures from unsupported content", () => {
    expect(isTransientFetchError(new Error("Request failed: HTTP 503"))).toBe(true);
    // A dropped TLS handshake on the VPS path (seen 3/40 to raw.githubusercontent.com) is transient.
    expect(
      isTransientFetchError(
        new TypeError("x", {
          cause: Object.assign(new Error("ssl"), { code: "ERR_SSL_UNEXPECTED_MESSAGE" }),
        }),
      ),
    ).toBe(true);
    expect(isTransientFetchError(new Error("Request failed: HTTP 429"))).toBe(true);
    expect(isTransientFetchError(new DOMException("The operation timed out", "TimeoutError"))).toBe(
      true,
    );
    expect(isTransientFetchError(new Error("Plugin directory has too many files"))).toBe(false);
    expect(isTransientFetchError(new Error("Request failed: HTTP 404"))).toBe(false);
  });
  it.each([
    { path: "../plugin.json", mode: "100644", type: "blob" },
    { path: "plugin.json", mode: "100644", type: "blob", size: 100_001 },
  ])("rejects unsafe tree entry %j", async (entry) => {
    await expect(
      fetchGitHubRepo(
        parsePluginSource("https://github.com/example/plugin"),
        undefined,
        reader([entry]),
      ),
    ).rejects.toThrow();
  });
  it("rejects SHA mismatch, incomplete trees and unsupported hosts without file fetches", async () => {
    const read = reader();
    await expect(
      fetchGitHubRepo(
        parsePluginSource(`https://github.com/example/plugin@${TREE}`),
        undefined,
        read,
      ),
    ).rejects.toThrow(/pin/);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(
      fetchGitHubRepo(parsePluginSource("https://other.example/a/b"), undefined, read),
    ).rejects.toThrow(/github.com/);
    await expect(
      fetchGitHubRepo(parsePluginSource("https://github.com/a/b"), undefined, async (url) =>
        url.includes("commits")
          ? JSON.stringify({ sha: SHA, commit: { tree: { sha: TREE } } })
          : JSON.stringify({ tree: [], truncated: true }),
      ),
    ).rejects.toThrow(/incomplete/);
  });
  it("scopes to a monorepo plugin subdirectory", async () => {
    const preview = await previewPluginInstall({
      source: "https://github.com/example/plugins@main#one",
      fetcher: async () => ({
        resolvedSha: SHA,
        files: files().map((f) => ({ ...f, path: `one/${f.path}` })),
      }),
    });
    expect(preview.source.subdir).toBe("one");
    expect(preview.skills).toHaveLength(1);
  });
});

describe("repositories publishing multiple plugin formats", () => {
  it("prefers the VNBot manifest over legacy and root manifests", () => {
    const preview = parse([
      ...files(),
      { path: ".cursor-plugin/plugin.json", content: JSON.stringify({ name: "legacy" }) },
      {
        path: ".vnbot-plugin/plugin.json",
        content: JSON.stringify({ ...manifest, name: "vnbot-package" }),
      },
    ]);
    expect(preview.name).toBe("vnbot-package");
    expect(preview.format).toBe("agent-plugins");
    expect(preview.mcpServers).toHaveLength(1);
  });

  it("previews the Figma layout without applying the root schema to legacy MCP config", async () => {
    const preview = await previewPluginInstall({
      source: "https://github.com/figma/mcp-server-guide",
      fetcher: async () => ({
        resolvedSha: SHA,
        files: [
          { path: "plugin.json", content: JSON.stringify({ ...manifest, name: "figma" }) },
          {
            path: ".cursor-plugin/plugin.json",
            content: JSON.stringify({ name: "figma", mcpServers: "./.mcp.json" }),
          },
          {
            path: "mcp.json",
            content: JSON.stringify({
              mcpServers: {
                figma: {
                  type: "http",
                  url: "https://mcp.figma.com/mcp",
                  _meta: { ideToolTitles: {} },
                },
              },
            }),
          },
          { path: "skills/design/SKILL.md", content: skill },
        ],
      }),
    });
    expect(preview.name).toBe("figma");
    expect(preview.mcpServers).toMatchObject([
      { endpoint: "https://mcp.figma.com/mcp", transport: "streamable_http" },
    ]);
    expect(preview.skipped).toEqual([]);
  });
  it("still rejects an unsupported standalone root schema", () => {
    expect(() =>
      parse([
        {
          path: "plugin.json",
          content: JSON.stringify({ name: "figma", $schema: "https://example.test/unknown" }),
        },
      ]),
    ).toThrow("Unsupported Agent Plugins schema");
  });
});
