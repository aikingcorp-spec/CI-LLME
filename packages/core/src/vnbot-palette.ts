import { vnbotBodyColors } from "@rakazo/ui-tokens";

/**
 * Accessory tone for a `vnbot` body colour. The palette, its `tone` flags and
 * `seededVnbotBodyColor` belong to the avatar contract (`@rakazo/ui-tokens`
 * `vnbotBodyColors`, `logo-avatar-traits.ts`); this only reads them.
 */
export type VnbotBodyTone = (typeof vnbotBodyColors)[number]["tone"];

/** `light` for the pale bodies; any colour outside the palette keeps the default (dark) accessory ink. */
export function vnbotBodyTone(hex: string): VnbotBodyTone {
  const found = vnbotBodyColors.find((color) => color.hex.toLowerCase() === hex.toLowerCase());
  return found?.tone ?? "dark";
}
