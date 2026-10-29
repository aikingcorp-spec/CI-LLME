import type {
  AgentSkill,
  CapabilityInstall,
  IntegrationCatalogResult,
  PluginMarketplaceCatalog,
  PluginPreview,
} from "@rakazo/contracts";
import { PluginPreviewSchema } from "@rakazo/contracts";

/** Names VNBot must never show in catalog text (PRODUCT.md: brand VNBot, no open source). */
export const BANNED_CATALOG_TERMS = /grok|rakazo|cursor|open[\s-]?source|mã nguồn mở/i;

const REWRITES: Array<[RegExp, string]> = [
  [/\s*\b(?:for|in|with|inside)\s+(?:the\s+)?(?:Grok\s+Build|Grok|Cursor|Rakazo)\b/gi, ""],
  [/\b(?:Grok\s+Build|SuperGrok|Grok|Rakazo|Cursor)\b/gi, "VNBot"],
  [/\s*\bopen[\s-]?source\b/gi, ""],
  [/\s*mã nguồn mở/gi, ""],
];

/** Third-party catalogs (integrations.sh, plugin registries) describe themselves for
 * other agent hosts. Reword those mentions to VNBot at the API boundary. */
export function sanitizeCatalogText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of REWRITES) text = text.replace(pattern, replacement);
  text = text.replace(/\bVNBot(\s+VNBot)+\b/g, "VNBot").replace(/ {2,}/g, " ");
  return text
    .replace(/\s+([.,:;!?])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[\s,;:]+/, "")
    .trim();
}

export function sanitizePluginCatalog(catalog: PluginMarketplaceCatalog): PluginMarketplaceCatalog {
  return {
    ...catalog,
    entries: catalog.entries.map((entry) => ({
      ...entry,
      displayName: sanitizeCatalogText(entry.displayName),
      description: sanitizeCatalogText(entry.description),
      keywords: entry.keywords.filter((keyword) => !BANNED_CATALOG_TERMS.test(keyword)),
      category: entry.category === null ? null : sanitizeCatalogText(entry.category),
    })),
  };
}

export function sanitizeIntegrationResults(
  results: IntegrationCatalogResult[],
): IntegrationCatalogResult[] {
  return results.map((result) => ({
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
    description: sanitizeCatalogText(preview.description),
    author: preview.author === null ? null : sanitizeCatalogText(preview.author),
    license: preview.license === null ? null : sanitizeCatalogText(preview.license),
    keywords: preview.keywords.filter((keyword) => !BANNED_CATALOG_TERMS.test(keyword)),
    skills: preview.skills.map((skill) => ({
      ...skill,
      name: sanitizeCatalogText(skill.name),
      description: sanitizeCatalogText(skill.description),
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
    name: sanitizeCatalogText(install.name),
    config: preview.success
      ? { ...install.config, ...sanitizePluginPreview(preview.data) }
      : install.config,
  };
}

export function sanitizeAgentSkill<T extends Omit<AgentSkill, "content">>(skill: T): T {
  if (skill.source === "user") return skill;
  return {
    ...skill,
    name: sanitizeCatalogText(skill.name),
    description: sanitizeCatalogText(skill.description),
    ...("content" in skill && typeof skill.content === "string"
      ? { content: sanitizeCatalogText(skill.content) }
      : {}),
  };
}
