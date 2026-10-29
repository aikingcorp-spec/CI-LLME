import { readFileSync } from "node:fs";
import { createRouterClient } from "@orpc/server";
import { pluginPreviewDto, previewPluginInstall } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BANNED_CATALOG_TERMS,
  isCatalogContentAllowed,
  sanitizeAgentSkill,
  sanitizeCatalogText,
  sanitizePluginCatalog,
  withCatalogLocale,
} from "./catalog-text.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor: Actor = {
  spaceId: "space-fixture",
  userId: "user-fixture",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
// Snapshot of the public xAI registry index (29/10/2026): Stripe and Supabase say "for Grok Build".
const xaiIndex = readFileSync(
  new URL("./__fixtures__/xai-marketplace-2026-10-29.json", import.meta.url),
  "utf8",
);
const cursorIndex = JSON.stringify({
  plugins: [
    {
      name: "notes",
      description: "Open-source notes for Cursor and Rakazo users",
      source: "notes",
    },
  ],
});

function setup(fetch?: typeof globalThis.fetch, overrides: Partial<RouterDeps> = {}) {
  const read = vi.fn(async (url: string) => {
    if (url.endsWith("plugin-index.json")) {
      const plugins = JSON.parse(xaiIndex).plugins as Array<{
        name: string;
        source: { sha?: string };
      }>;
      return JSON.stringify({
        plugins: Object.fromEntries(
          plugins.map((p) => [p.name, { sha: p.source.sha, components: { skills: [{}] } }]),
        ),
      });
    }
    if (url.includes("/git/trees/"))
      return JSON.stringify({ tree: [{ path: "notes/skills/plan/SKILL.md", type: "blob" }] });
    if (url.includes("xai-org") && url.endsWith("marketplace.json")) return xaiIndex;
    if (url.endsWith("marketplace.json")) return cursorIndex;
    if (url.endsWith("notes/.cursor-plugin/plugin.json"))
      return JSON.stringify({
        name: "notes",
        displayName: "Grok Voice",
        category: "Rakazo",
        keywords: ["Cursor", "voice"],
      });
    throw new Error("Request failed: HTTP 404");
  });
  const router = createRouter({
    prisma: {} as never,
    pluginMarketplaceRead: read,
    remoteConnectors: fetch ? { fetch } : undefined,
    env: {
      webOrigin: "http://localhost:5173",
      defaultProvider: "fake",
      defaultModel: "fake",
      integrationsCatalogUrl: "https://catalog.example.test/",
    },
    dataDir: "/tmp/catalog-text-test",
    ...overrides,
  } as unknown as RouterDeps);
  return createRouterClient(router, { context: { actor } });
}

describe("catalog text", () => {
  it("does not relabel foreign product copy", () => {
    expect(sanitizeCatalogText("Stripe development plugin for Grok Build: best practices.")).toBe(
      "",
    );
    expect(sanitizeCatalogText("Give Grok a real browser")).toBe("");
    expect(sanitizeCatalogText("An open-source Rakazo tool")).toBe("An VNBot tool");
  });

  it("plugin marketplace response carries no banned term in any visible text", async () => {
    const client = setup();
    const result = await client.marketplace.catalog({ query: "" });
    const names = result.entries.map((entry) => entry.name);
    expect(names).not.toContain("stripe");
    expect(names).not.toContain("supabase");
    expect(names).not.toContain("notes");
    const offending = catalogStrings({ catalog: result }).filter((text) =>
      BANNED_CATALOG_TERMS.test(text),
    );
    expect(offending).toEqual([]);
  });

  it("integration catalog search response carries no banned term", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        results: [
          {
            domain: "supabase.com",
            name: "Supabase for Grok Build",
            description: "Official Supabase plugin for Grok Build, open source, works in Cursor.",
            url: "https://integrations.sh/supabase.com/",
            surfaces: [
              {
                kind: "mcp",
                slug: "supabase",
                url: "https://mcp.supabase.com",
                auth: { kind: "oauth", note: "OAuth in Rakazo and Grok" },
              },
            ],
          },
        ],
      }),
    ) as unknown as typeof globalThis.fetch;
    const client = setup(fetch);
    const result = await client.capabilities.catalogSearch({ query: "supabase" });
    expect(result.results).toHaveLength(0);
    const visible = catalogStrings(result.results);
    expect(visible.filter((text) => BANNED_CATALOG_TERMS.test(text))).toEqual([]);
  });
});

// Protocol identifiers, source URLs, file paths and format enums must stay usable for installs.
// Marketplace entry.name is the upstream slug; preview/skill/install names are visible text.
function catalogStrings(value: unknown, path: string[] = []): string[] {
  const key = path.at(-1) ?? "";
  if (
    [
      "id",
      "source",
      "installedSource",
      "pinnedSource",
      "registry",
      "homepage",
      "repository",
      "logo",
      "domains",
      "domain",
      "slug",
      "url",
      "pageUrl",
      "files",
      "format",
      "unavailableRegistries",
    ].includes(key)
  )
    return [];
  if (key === "name" && path[0] === "catalog" && path[1] === "entries" && path.length === 4)
    return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.flatMap((item, index) => catalogStrings(item, [...path, String(index)]));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => catalogStrings(item, [...path, key]));
  return [];
}

const skillSource = "https://github.com/example/grok-voice";
const catalogCopy = "Voice for Grok Build, Rakazo, Cursor, open source, mã nguồn mở and SuperGrok";
const skillContent = `---
name: Grok Voice
description: ${catalogCopy}
---
Use Grok Voice with Cursor.
`;
const skillFetcher = async () => ({
  resolvedSha: "a".repeat(40),
  files: [
    {
      path: ".grok-plugin/plugin.json",
      content: JSON.stringify({
        name: "grok-voice",
        displayName: "Grok Voice",
        description: catalogCopy,
        author: { name: "Rakazo" },
        keywords: ["voice", "Grok", "open source", "Cursor"],
      }),
    },
    { path: "skills/grok-voice/SKILL.md", content: skillContent },
  ],
});

async function skillsClient(source = "plugin") {
  const preview = pluginPreviewDto(
    await previewPluginInstall({ source: skillSource, fetcher: skillFetcher }),
  );
  const row = {
    id: "skill-grok-voice",
    spaceId: actor.spaceId,
    userId: actor.userId,
    allSpaces: true,
    name: "Grok Voice",
    description: catalogCopy,
    content: skillContent,
    source,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return {
    row,
    client: setup(undefined, {
      pluginRepoFetcher: skillFetcher,
      prisma: {
        agentSkill: { findMany: vi.fn(async () => [row]), findFirst: vi.fn(async () => row) },
        capabilityInstall: {
          findMany: vi.fn(async () => [
            {
              spaceId: actor.spaceId,
              allSpaces: true,
              id: "install-grok-voice",
              kind: "plugin",
              name: "Grok Voice",
              source: skillSource,
              version: "1.0.0",
              digest: preview.digest,
              config: preview,
              createdAt: new Date(0),
            },
          ]),
        },
      } as never,
    }),
  };
}

describe("catalog text keeps ordinary prose and markdown", () => {
  it("keeps the lowercase word cursor and strips only the brand", () => {
    expect(sanitizeCatalogText("Paginate with the cursor field. Works in Cursor.")).toBe(
      "Paginate with the cursor field. Works.",
    );
  });

  it("preserves markdown indentation, newlines and code blocks", () => {
    const markdown =
      "# Steps\n\n- one\n  - nested\n    - deeper\n\n```ts\nif (x) {\n    run();\n}\n```";
    expect(sanitizeCatalogText(markdown)).toBe(markdown);
  });
});

describe("whole Skills screen responses", () => {
  it("omits foreign catalog skills and rejects direct catalog previews without mutating stored rows", async () => {
    const { client, row } = await skillsClient("builtin");
    expect((await client.agentSkills.list()).some((skill) => skill.id === row.id)).toBe(false);
    await expect(client.agentSkills.get({ skillId: row.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client.capabilities.pluginPreview({ source: skillSource })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Chưa thể xem trước tiện ích này. Vui lòng thử lại sau.",
    });
    expect(row.name).toBe("Grok Voice");
    expect(row.content).toBe(skillContent);
  });

  it("keeps an installed plugin skill listed so it can be removed", async () => {
    const { client, row } = await skillsClient("plugin");
    expect((await client.agentSkills.list()).some((skill) => skill.id === row.id)).toBe(true);
  });

  it("preserves a user's authored skill text", async () => {
    const { client, row } = await skillsClient("user");
    expect((await client.agentSkills.list()).find((skill) => skill.id === row.id)).toMatchObject({
      name: row.name,
      description: row.description,
    });
    expect(await client.agentSkills.get({ skillId: row.id })).toMatchObject({
      name: row.name,
      description: row.description,
      content: skillContent,
    });
  });
});

describe("catalog description locale", () => {
  const skill = {
    source: "builtin",
    description: "Adversarial review of a diff/PR/plan. Review only; never applies fixes.",
  } as unknown as Parameters<typeof sanitizeAgentSkill>[0];

  it("shows known registry descriptions in Vietnamese by default and for vi", () => {
    expect(sanitizeAgentSkill(skill).description).toBe(
      "Rà soát phản biện một diff, PR hoặc kế hoạch. Chỉ rà soát, không tự sửa.",
    );
    expect(withCatalogLocale("vi", () => sanitizeAgentSkill(skill).description)).toMatch(
      /^Rà soát/,
    );
  });

  it("keeps English for other locales and for unknown text", () => {
    expect(withCatalogLocale("en", () => sanitizeAgentSkill(skill).description)).toBe(
      skill.description,
    );
    expect(sanitizeAgentSkill({ ...skill, description: "Brand new entry." }).description).toBe(
      "Brand new entry.",
    );
  });
});

describe("catalog exclusion policy", () => {
  it.each([
    "xAI",
    "GROK Voice",
    "https://cursor.com/account",
    "vnbot SDK",
    "VNBot Bot",
    "VNBot syncs and stores",
  ])("rejects %s in names, descriptions and URLs", (text) => {
    for (const key of ["name", "displayName", "description", "homepage", "source", "url"])
      expect(isCatalogContentAllowed({ [key]: text })).toBe(false);
    expect(isCatalogContentAllowed({ surfaces: [{ url: text }] })).toBe(false);
  });
  it("filters before translation and stays idempotent without mutating input", () => {
    const entry = {
      name: "notes",
      displayName: "Notes",
      description: "Daily notes",
      keywords: [],
      category: null,
      source: "https://github.com/example/notes",
    };
    const catalog = {
      entries: [
        entry,
        { ...entry, description: "Plaid linked by xAI" },
        { ...entry, displayName: "Grok SDK" },
      ],
      unavailableRegistries: [],
      skippedEntries: 0,
    } as unknown as Parameters<typeof sanitizePluginCatalog>[0];
    const result = sanitizePluginCatalog(catalog);
    expect(result.entries).toHaveLength(1);
    expect(sanitizePluginCatalog(result)).toEqual(result);
    expect(catalog.entries).toHaveLength(3);
  });
});

it("keeps searchable apps after a preview transport failure and hides technical causes", async () => {
  const client = setup(undefined, {
    pluginRepoFetcher: async () => {
      throw new Error("Request failed: HTTP 403");
    },
  });
  const before = await client.marketplace.catalog({ query: "figma" });
  expect(before.entries).toHaveLength(1);
  await expect(
    client.capabilities.pluginPreview({ source: before.entries[0]!.source }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Chưa thể xem trước tiện ích này. Vui lòng thử lại sau.",
  });
  expect(await client.marketplace.catalog({ query: "figma" })).toEqual(before);
});

it("returns a friendly catalog search error without the upstream cause", async () => {
  const client = setup(
    vi.fn(async () => {
      throw new Error("upstream catalog unavailable");
    }) as unknown as typeof globalThis.fetch,
  );
  await expect(client.capabilities.catalogSearch({ query: "Sentry" })).rejects.toMatchObject({
    code: "BAD_GATEWAY",
    message: "Chưa thể tìm ứng dụng lúc này. Vui lòng thử lại sau.",
  });
});
