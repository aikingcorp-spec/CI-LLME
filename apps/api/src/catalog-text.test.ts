import { readFileSync } from "node:fs";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { BANNED_CATALOG_TERMS, sanitizeCatalogText } from "./catalog-text.js";
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

/** Every string a user can read: identifiers (id, source, URLs, registry key) are excluded. */
function visibleStrings(value: unknown, key = ""): string[] {
  const hidden = new Set([
    "id",
    "source",
    "installedSource",
    "registry",
    "homepage",
    "pageUrl",
    "domain",
    "slug",
    "domains",
    "name",
    "logo",
  ]);
  if (hidden.has(key)) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.flatMap((item) => visibleStrings(item, key === "keywords" ? "" : ""));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => visibleStrings(v, k));
  return [];
}

function setup(fetch?: typeof globalThis.fetch) {
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
  } as unknown as RouterDeps);
  return createRouterClient(router, { context: { actor } });
}

describe("catalog text", () => {
  it("rewords other hosts' names out of catalog copy", () => {
    expect(sanitizeCatalogText("Stripe development plugin for Grok Build: best practices.")).toBe(
      "Stripe development plugin: best practices.",
    );
    expect(sanitizeCatalogText("Give Grok a real browser")).toBe("Give VNBot a real browser");
    expect(sanitizeCatalogText("An open-source Rakazo tool")).toBe("An VNBot tool");
  });

  it("plugin marketplace response carries no banned term in any visible text", async () => {
    const client = setup();
    const result = await client.marketplace.catalog({ query: "" });
    const names = result.entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["stripe", "supabase"]));
    const offending = visibleStrings(result).filter((text) => BANNED_CATALOG_TERMS.test(text));
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
    expect(result.results).toHaveLength(1);
    const visible = visibleStrings(result.results).concat(result.results.map((r) => r.name));
    expect(result.results[0]?.description).toBe("Official Supabase plugin, works.");
    expect(visible.filter((text) => BANNED_CATALOG_TERMS.test(text))).toEqual([]);
  });
});
