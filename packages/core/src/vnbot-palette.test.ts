import { vnbotBodyColors } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import { seededVnbotBodyColor } from "./logo-avatar-traits.js";
import { vnbotBodyTone } from "./vnbot-palette.js";

describe("VNBot body tone", () => {
  it("follows the tone flag of every palette colour", () => {
    for (const color of vnbotBodyColors) {
      expect(vnbotBodyTone(color.hex)).toBe(color.tone);
      expect(vnbotBodyTone(color.hex.toLowerCase())).toBe(color.tone);
    }
  });

  it("marks the four pale bodies as light and unknown colours as dark", () => {
    expect(vnbotBodyTone("#F3E1C9")).toBe("light");
    expect(vnbotBodyTone("#F1A4A4")).toBe("light");
    expect(vnbotBodyTone("#F2B705")).toBe("light");
    expect(vnbotBodyTone("#7BC043")).toBe("light");
    expect(vnbotBodyTone("#93A460")).toBe("dark");
    expect(vnbotBodyTone("#112233")).toBe("dark");
  });

  it("gives every seeded body colour a known tone", () => {
    const hexes = vnbotBodyColors.map((color) => color.hex);
    const seeded = seededVnbotBodyColor("bot-nón");
    expect(hexes).toContain(seeded);
  });
});
