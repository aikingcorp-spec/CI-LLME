/**
 * Single source of truth for brand terms VNBot must never show to users
 * (PRODUCT.md: brand is VNBot, never mention open source; CORRECT 2026-10-29 item 2).
 * Used by the API catalog sanitizer and by scripts/check-banned-brand.ts (pnpm lint).
 */

/**
 * Banned in user-facing descriptions and text (case-insensitive), but not in functional
 * endpoint URLs in source (API hosts, registry sources, privacy disclosures) — Maya 2026-10-29.
 */
export const BANNED_DESCRIPTION_TERMS = [
  "xai",
  "(?:[a-z0-9-]+\\.)?x\\.ai",
  "cursor\\.com",
  "vnbot[\\s]+voice",
  "vnbot[\\s]+sdk",
  "vnbot[\\s]+bot",
  "vnbot[\\s]+syncs[\\s]+and[\\s]+stores",
] as const;

/** Terms matched case-insensitively. */
export const BANNED_BRAND_TERMS_ANY_CASE = [
  "grok",
  "rakazo",
  "open[\\s-]?source",
  "mã nguồn mở",
  "github\\.com/elie222",
  // The upstream owner in any URL form: ghcr.io/…, raw.githubusercontent.com/…, api.github.com/repos/….
  "elie222",
  "apps\\.apple\\.com/app/rakazo",
] as const;

/** Terms matched case-sensitively: lowercase "cursor" is an ordinary word (text cursor). */
export const BANNED_BRAND_TERMS_CASED = ["Cursor", "CURSOR"] as const;

/** Catalog keyword filter: stricter, any-case match including "cursor". */
export const BANNED_CATALOG_TERMS = new RegExp(
  [...BANNED_BRAND_TERMS_ANY_CASE, "cursor"].join("|"),
  "i",
);

/** Returns the banned brand terms found in user-facing text. */
export function findBannedBrandTerms(
  text: string,
  options: { modelProviderList?: boolean; url?: boolean } = {},
): string[] {
  if (options.modelProviderList && /^xai$/iu.test(text)) return [];
  if (options.modelProviderList)
    text = text.replace(/https:\/\/docs\.x\.ai(?=[/?#\s]|$)[^\s"'<>]*/giu, "");
  const terms = options.url
    ? BANNED_BRAND_TERMS_ANY_CASE
    : [...BANNED_BRAND_TERMS_ANY_CASE, ...BANNED_DESCRIPTION_TERMS];
  const anyCase = new RegExp(terms.join("|"), "giu");
  const cased = new RegExp(`\\b(?:${BANNED_BRAND_TERMS_CASED.join("|")})\\b`, "gu");
  return [...text.matchAll(anyCase), ...text.matchAll(cased)].map((m) => m[0]);
}

/** Reject foreign product content before localization; never relabel it as VNBot. */
// Whole words only (so e.g. "Taxaid" or "grokking" survive), and hosts matched as hosts
// (x.ai / *.x.ai, cursor.com / *.cursor.com), not as substrings like "max.ai".
export const EXCLUDED_CATALOG_CONTENT =
  /\bcursor\b(?!\.[a-z])|\b(?:xai|grok|elie222)\b|(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:x\.ai|cursor\.com)(?![a-z0-9-]|\.[a-z0-9])|\bvnbot\s+(?:voice|sdk|bot|origin|syncs\s+and\s+stores)\b/iu;

/** URLs are judged by their host and repository owner, never by a repository slug. */
export function isExcludedCatalogText(text: string): boolean {
  if (!/^https?:\/\/\S+$/iu.test(text)) return EXCLUDED_CATALOG_CONTENT.test(text);
  const url = new URL(text);
  const host = url.hostname.toLowerCase();
  if (["x.ai", "cursor.com"].some((banned) => host === banned || host.endsWith(`.${banned}`)))
    return true;
  const segments = url.pathname.toLowerCase().split("/").filter(Boolean);
  const owner = host === "api.github.com" && segments[0] === "repos" ? segments[1] : segments[0];
  return (
    ["github.com", "raw.githubusercontent.com", "api.github.com", "ghcr.io"].includes(host) &&
    ["cursor", "xai", "xai-org", "elie222"].includes(owner ?? "")
  );
}
