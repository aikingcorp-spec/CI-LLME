import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentSkill,
  CapabilityInstall,
  IntegrationCatalogResult,
  PluginMarketplaceCatalog,
  PluginPreview,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import {
  BANNED_CATALOG_TERMS,
  EXCLUDED_CATALOG_CONTENT,
  isExcludedCatalogText,
} from "@rakazo/core/banned-brand";
import { CATALOG_DESCRIPTIONS_VI } from "./catalog-descriptions-vi.js";

/** Names VNBot must never show in catalog text; the term list lives in @rakazo/core/banned-brand. */
export { BANNED_CATALOG_TERMS } from "@rakazo/core/banned-brand";

const REWRITES: Array<[RegExp, string]> = [
  [/[ \t]*\b(?:for|in|with|inside)[ \t]+(?:the[ \t]+)?(?:Rakazo)\b/gi, ""],
  [/[ \t]*\b(?:[Ff]or|[Ii]n|[Ww]ith|[Ii]nside)[ \t]+(?:the[ \t]+)?(?:Cursor|CURSOR)\b/g, ""],
  [/\b(?:Rakazo)\b/gi, "VNBot"],
  [/\b(?:Cursor|CURSOR)\b/g, "VNBot"],
  [/[ \t]*\bopen[ \t-]?source\b/gi, ""],
  [/[ \t]*mã nguồn mở/gi, ""],
];

/** Third-party catalogs (integrations.sh, plugin registries) describe themselves for
 * other agent hosts. Exclude foreign product content before localizing responses. */
const uiLocale = new AsyncLocalStorage<string | null>();

/** Runs a request with the UI locale the web client sent (x-vnbot-ui-locale). */
export function withCatalogLocale<T>(locale: string | null, run: () => T): T {
  return uiLocale.run(locale, run);
}

/** VNBot is Vietnamese-first: without a locale header, descriptions are shown in Vietnamese. */
function localizeDescription(english: string): string {
  const locale = uiLocale.getStore() ?? "vi";
  if (!locale.toLowerCase().startsWith("vi")) return english;
  return CATALOG_DESCRIPTIONS_VI[english] ?? english;
}

function sanitizeDescription(value: string): string {
  return localizeDescription(sanitizeCatalogText(value));
}

export function sanitizeCatalogText(value: string): string {
  if (EXCLUDED_CATALOG_CONTENT.test(value)) return "";
  let text = value;
  for (const [pattern, replacement] of REWRITES) text = text.replace(pattern, replacement);
  text = text.replace(/\bVNBot([ \t]+VNBot)+\b/g, "VNBot").replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 ");
  if (EXCLUDED_CATALOG_CONTENT.test(text)) return "";
  return text
    .replace(/[ \t]+([.,:;!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

/** A registry name is shown as-is unless it is a banned brand; then the value is removed, not renamed. */
function visibleRegistry(name: string): string {
  return isExcludedCatalogText(name) || BANNED_CATALOG_TERMS.test(name) ? "" : name;
}

export function sanitizePluginCatalog(catalog: PluginMarketplaceCatalog): PluginMarketplaceCatalog {
  return {
    ...catalog,
    unavailableRegistries: catalog.unavailableRegistries.map(visibleRegistry),
    entries: catalog.entries.filter(isCatalogContentAllowed).map((entry) => ({
      ...entry,
      registry: visibleRegistry(entry.registry),
      displayName: sanitizeCatalogText(entry.displayName),
      description: sanitizeDescription(entry.description),
      keywords: entry.keywords.filter((keyword) => !BANNED_CATALOG_TERMS.test(keyword)),
      category: entry.category === null ? null : sanitizeCatalogText(entry.category),
    })),
  };
}

export function sanitizeIntegrationResults(
  results: IntegrationCatalogResult[],
): IntegrationCatalogResult[] {
  return results.filter(isCatalogContentAllowed).map((result) => ({
    ...result,
    name: sanitizeCatalogText(result.name),
    description: sanitizeCatalogText(result.description),
    surfaces: result.surfaces.map((surface) => ({
      ...surface,
      auth: surface.auth?.note
        ? { ...surface.auth, note: sanitizeCatalogText(surface.auth.note) }
        : surface.auth,
    })),
  }));
}

/** Only response copies are rewritten; install sources and execution metadata stay intact. */
export function sanitizePluginPreview(preview: PluginPreview): PluginPreview {
  return {
    ...preview,
    name: sanitizeCatalogText(preview.name),
    description: sanitizeDescription(preview.description),
    author: preview.author === null ? null : sanitizeCatalogText(preview.author),
    license: preview.license === null ? null : sanitizeCatalogText(preview.license),
    keywords: preview.keywords.filter((keyword) => !BANNED_CATALOG_TERMS.test(keyword)),
    skills: preview.skills.filter(isCatalogContentAllowed).map((skill) => ({
      ...skill,
      name: sanitizeCatalogText(skill.name),
      description: sanitizeDescription(skill.description),
    })),
    mcpServers: preview.mcpServers.map((server) => ({
      ...server,
      name: sanitizeCatalogText(server.name),
    })),
    skipped: preview.skipped.map((part) => ({
      ...part,
      name: sanitizeCatalogText(part.name),
      reason: sanitizeCatalogText(part.reason),
    })),
  };
}

export function sanitizeCatalogInstall(install: CapabilityInstall): CapabilityInstall {
  if (install.kind !== "plugin") return install;
  const preview = PluginPreviewSchema.safeParse(install.config);
  return {
    ...install,
    name: sanitizeCatalogText(install.name) || "Tiện ích",
    config: preview.success
      ? { ...install.config, ...sanitizePluginPreview(preview.data) }
      : install.config,
  };
}

export function sanitizeAgentSkill<T extends Omit<AgentSkill, "content">>(skill: T): T {
  if (skill.source === "user") return skill;
  return {
    ...skill,
    description: sanitizeDescription(skill.description),
    ...("content" in skill && typeof skill.content === "string"
      ? { content: sanitizeCatalogText(skill.content) }
      : {}),
  };
}

/** Scan content and URLs, leaving registry/protocol identifiers out of the product policy. */
export function isCatalogContentAllowed(value: unknown): boolean {
  if (typeof value === "string") return !isExcludedCatalogText(value);
  if (Array.isArray(value)) return value.every(isCatalogContentAllowed);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, item]) =>
      ["id", "registry", "format", "content", "files"].includes(key) ||
      isCatalogContentAllowed(item),
  );
}
