/**
 * Name shown on the web shell, the document title, and the installable app.
 * Technical identifiers stay Rakazo: package names, `rakazo.uiLocale`,
 * the service-worker cache prefix, and `rakazoDesktop`.
 */
export const PRODUCT_DISPLAY_NAME = "VNBot";

export type BrandVariant = "wordmark" | "powered" | "leaf";
export type BrandAppearance = "light" | "dark";

/** File under `apps/web/public/brand`, served at `/brand/`. */
export function brandAssetFile(variant: BrandVariant, appearance: BrandAppearance): string {
  if (variant === "leaf") return `vnbot-leaf-${appearance}.svg`;
  if (variant === "powered") return `vnbot-wordmark-powered-${appearance}.svg`;
  return `vnbot-wordmark-${appearance}.svg`;
}

export function brandAssetPath(variant: BrandVariant, appearance: BrandAppearance): string {
  return `/brand/${brandAssetFile(variant, appearance)}`;
}
