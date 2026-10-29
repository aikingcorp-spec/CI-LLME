/**
 * Single source of truth for brand terms VNBot must never show to users
 * (PRODUCT.md: brand is VNBot, never mention open source; CORRECT 2026-10-29 item 2).
 * Used by the API catalog sanitizer and by scripts/check-banned-brand.ts (pnpm lint).
 */

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
export function findBannedBrandTerms(text: string): string[] {
  const anyCase = new RegExp(BANNED_BRAND_TERMS_ANY_CASE.join("|"), "giu");
  const cased = new RegExp(`\\b(?:${BANNED_BRAND_TERMS_CASED.join("|")})\\b`, "gu");
  return [...text.matchAll(anyCase), ...text.matchAll(cased)].map((m) => m[0]);
}
