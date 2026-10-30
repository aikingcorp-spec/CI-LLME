import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentSkill,
  CapabilityInstall,
  IntegrationCatalogResult,
  PluginMarketplaceCatalog,
  PluginPreview,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";
import { EXCLUDED_CATALOG_CONTENT, isExcludedCatalogText } from "@rakazo/core/banned-brand";
import {
  CATALOG_DESCRIPTIONS_VI,
  CATALOG_DESCRIPTIONS_VI_BY_NAME,
} from "./catalog-descriptions-vi.js";

/** Third-party catalogs (integrations.sh, plugin registries) describe themselves for
 * other agent hosts. Exclude foreign product content before localizing responses. */
const uiLocale = new AsyncLocalStorage<string | null>();

/** Runs a request with the UI locale the web client sent (x-vnbot-ui-locale). */
export function withCatalogLocale<T>(locale: string | null, run: () => T): T {
  return uiLocale.run(locale, run);
}

/** VNBot is Vietnamese-first: without a locale header, descriptions are shown in Vietnamese. */
function isVietnamese(): boolean {
  return (uiLocale.getStore() ?? "vi").toLowerCase().startsWith("vi");
}

function sanitizeDescription(value: string, name?: string): string {
  const english = sanitizeCatalogText(value);
  if (!isVietnamese()) return english;
  // A description the brand filter blanked gets our own copy for that entry, if we wrote one.
  const own = !english && name ? CATALOG_DESCRIPTIONS_VI_BY_NAME[name] : undefined;
  return own ?? CATALOG_DESCRIPTIONS_VI[english] ?? english;
}

export function sanitizeCatalogText(value: string): string {
  if (EXCLUDED_CATALOG_CONTENT.test(value)) return "";
  return value
    .replace(/[ \t]+([.,:;!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

/** A registry name is shown as-is unless it is a banned brand; then the value is removed, not renamed. */
function visibleRegistry(name: string): string {
  return isExcludedCatalogText(name) ? "" : name;
}

export function sanitizePluginCatalog(catalog: PluginMarketplaceCatalog): PluginMarketplaceCatalog {
  return {
    ...catalog,
    unavailableRegistries: catalog.unavailableRegistries.map(visibleRegistry),
    entries: catalog.entries
      .filter(({ name, displayName, homepage, domains }) =>
        isCatalogContentAllowed({ name, displayName, homepage, domains }),
      )
      .map((entry) => ({
        ...entry,
        registry: visibleRegistry(entry.registry),
        displayName: sanitizeCatalogText(entry.displayName),
        description: sanitizeDescription(entry.description, entry.name),
        keywords: entry.keywords.filter((keyword) => !isExcludedCatalogText(keyword)),
        category: entry.category === null ? null : sanitizeCatalogText(entry.category),
      })),
  };
}

export function sanitizeIntegrationResults(
  results: IntegrationCatalogResult[],
): IntegrationCatalogResult[] {
  return results
    .filter(({ domain, name, pageUrl }) => isCatalogContentAllowed({ domain, name, pageUrl }))
    .map((result) => ({
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
    description: sanitizeDescription(preview.description, preview.name),
    author: preview.author === null ? null : sanitizeCatalogText(preview.author),
    license: preview.license === null ? null : sanitizeCatalogText(preview.license),
    keywords: preview.keywords.filter((keyword) => !isExcludedCatalogText(keyword)),
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
  if (skill.source !== "builtin") return skill;
  return {
    ...skill,
    description: sanitizeDescription(skill.description),
    ...("content" in skill && typeof skill.content === "string"
      ? { content: sanitizeCatalogText(skill.content) }
      : {}),
  };
}

/**
 * Whether a plugin may be shown or previewed. Only what names it (its name, homepage and the hosts
 * it connects to) can exclude it; banned words in its prose are blanked by sanitizePluginPreview,
 * so "Sentry Plugin for Grok" stays installable. Install sources are never judged: a plugin
 * vendored in a registry repository would otherwise inherit that registry's owner.
 */
export function isPluginPreviewAllowed(
  preview: Pick<PluginPreview, "name" | "homepage" | "repository" | "mcpServers">,
): boolean {
  return isCatalogContentAllowed({
    name: preview.name,
    homepage: preview.homepage,
    repository: preview.repository,
    endpoints: preview.mcpServers.map((server) => server.endpoint),
  });
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
