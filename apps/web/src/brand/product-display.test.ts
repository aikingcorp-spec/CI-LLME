import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CACHE_PREFIX } from "../pwa/service-worker";
import type { BrandAppearance, BrandVariant } from "./product-display";
import { brandAssetFile, PRODUCT_DISPLAY_NAME } from "./product-display";

const appearances: BrandAppearance[] = ["light", "dark"];
const variants: BrandVariant[] = ["wordmark", "powered", "leaf"];

describe("VNBot display name", () => {
  it("uses VNBot on screen and keeps the locale and cache identifiers", () => {
    expect(PRODUCT_DISPLAY_NAME).toBe("VNBot");
    expect(CACHE_PREFIX).toBe("rakazo-shell-");
    const localeSource = readFileSync(new URL("../lib/ui-locale.ts", import.meta.url), "utf8");
    expect(localeSource).toContain('export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale"');
  });

  it("points the document title and the Apple web-app title at VNBot", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(html).toContain("<title>VNBot</title>");
    expect(html).toContain('name="apple-mobile-web-app-title" content="VNBot"');
  });

  it("renames the auth, onboarding, and return catalogs without touching the billing error id", () => {
    const ids = [
      "Sign in to VNBot",
      "Create your VNBot",
      "Open VNBot",
      "Return to VNBot",
      "VNBot credits",
      "VNBot",
      "Welcome to VNBot",
      "How will you use VNBot?",
      "What do you most want VNBot to help with?",
      "Not in VNBot's catalog",
      "Not supported in VNBot",
      "Not used by VNBot",
      "Use VNBot credits",
      "Choose how to use VNBot",
      "Enjoying VNBot?",
      "Allow VNBot to use Speech Recognition and the microphone in System Settings.",
      "Paste the OpenAI-compatible address from your server. VNBot adds /v1 if needed.",
      "rakazo-shared and IDs starting with bot- are reserved for VNBot.",
    ];
    const locales = readdirSync(new URL("../locales", import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(locales.length).toBeGreaterThan(10);
    for (const locale of locales) {
      const catalog = readFileSync(
        new URL(`../locales/${locale}/messages.po`, import.meta.url),
        "utf8",
      );
      for (const id of ids) {
        const entry = catalog
          .split("\n\n")
          .find((block) => block.includes(`msgid ${JSON.stringify(id)}\n`));
        expect(entry, `${locale}: ${id}`).toBeTruthy();
        expect(entry, `${locale}: ${id}`).toContain("VNBot");
        expect(entry, `${locale}: ${id}`).not.toContain("Rakazo");
      }
      expect(catalog).toContain(
        'msgid "Connect your own API key in Models or choose Rakazo credits in Billing."',
      );
    }
    const avatar = readFileSync(
      new URL("../pages/shell/avatar-studio-popover.tsx", import.meta.url),
      "utf8",
    );
    expect(avatar).toContain('value="vnbot"');
    expect(avatar).toContain("<Trans>VNBot</Trans>");
  });

  it("serves a brand file for every wordmark variant and appearance", () => {
    for (const variant of variants) {
      for (const appearance of appearances) {
        const file = brandAssetFile(variant, appearance);
        const svg = readFileSync(new URL(`../../public/brand/${file}`, import.meta.url), "utf8");
        expect(svg.trim().startsWith("<svg"), file).toBe(true);
      }
    }
  });
});
