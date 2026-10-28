import { describe, expect, it } from "vitest";
import { contrastRatio } from "./bot-avatar-colors.js";
import {
  seededLogoAvatarColor,
  seededVnbotBodyColor,
  VNBOT_BODY_COLORS,
} from "./logo-avatar-traits.js";

describe("seeded logo colours", () => {
  it("reproduces a valid colour from a persisted identity across calls and reload data", () => {
    const first = seededLogoAvatarColor("persistent-bot-1");
    expect(first).toMatch(/^#[0-9A-F]{6}$/);
    for (let index = 0; index < 30; index++) {
      const restored = JSON.parse(JSON.stringify({ id: "persistent-bot-1" }));
      expect(seededLogoAvatarColor(restored.id)).toBe(first);
      expect(logoAvatarTraits(restored.id).color).toBe(first);
    }
  });

  it("provides fresh hues across a fleet with contrast headroom for the shaded face", () => {
    const colors = Array.from({ length: 1000 }, (_, index) =>
      seededLogoAvatarColor(`bot-${index}`),
    );
    expect(new Set(colors).size).toBeGreaterThan(990);
    for (const color of colors) expect(contrastRatio(color, "#141414")).toBeGreaterThanOrEqual(7);
  });

  it("preserves a saved colour and leaves seeded motion parameters unchanged", () => {
    const { color, originalOrange: _orange, ...seeded } = logoAvatarTraits("persistent-bot-1");
    const {
      color: explicit,
      originalOrange: _explicitOrange,
      ...chosen
    } = logoAvatarTraits("persistent-bot-1", "#123456");
    expect(color).toBe(seededLogoAvatarColor("persistent-bot-1"));
    expect(explicit).toBe("#123456");
    expect(chosen).toEqual(seeded);
  });
});

import { LOGO_AVATAR_LOOP_MS, logoAvatarTraits } from "./logo-avatar-traits.js";

describe("vnbot body colours", () => {
  it("picks a stable hex from the twelve palette tokens", () => {
    expect(VNBOT_BODY_COLORS).toEqual([
      "#93A460",
      "#6C763D",
      "#F3E1C9",
      "#4D5A80",
      "#F1A4A4",
      "#C8322B",
      "#F2B705",
      "#7BC043",
      "#1FA7A0",
      "#E8743B",
      "#A8714B",
      "#5566B0",
    ]);
    const first = seededVnbotBodyColor("persistent-bot-1");
    expect(VNBOT_BODY_COLORS).toContain(first);
    expect(seededVnbotBodyColor("persistent-bot-1")).toBe(first);
  });
});

describe("stable logo avatar traits", () => {
  it("reproduces colour, phase and timing from the same identity", () => {
    const first = logoAvatarTraits("inbox-01");
    for (let index = 0; index < 20; index++) expect(logoAvatarTraits("inbox-01")).toEqual(first);
  });

  it("gives a fleet independent blink and movement clocks", () => {
    const fleet = Array.from({ length: 200 }, (_, index) => logoAvatarTraits(`bot-${index}`));
    expect(new Set(fleet.map((bot) => `${bot.blinkMs}:${bot.blinkDelayMs}`)).size).toBe(200);
    expect(new Set(fleet.map((bot) => `${bot.periods.reading}:${bot.phase}`)).size).toBe(200);
    expect(new Set(fleet.map((bot) => bot.blinkVariant))).toEqual(new Set(["three", "four"]));
    expect(fleet.every((bot) => bot.blinkMs === 24000)).toBe(true);
    expect(fleet.every((bot) => bot.blinkDelayMs <= 0 && bot.blinkDelayMs >= -bot.blinkMs)).toBe(
      true,
    );
  });

  it("closes every seeded track in the exact common export interval", () => {
    for (let index = 0; index < 200; index++) {
      const traits = logoAvatarTraits(`bot-${index}`);
      for (const period of [traits.blinkMs, ...Object.values(traits.periods)]) {
        expect(LOGO_AVATAR_LOOP_MS % period).toBe(0);
      }
    }
  });

  it("keeps movement identity when the saved colour changes", () => {
    const {
      color: _firstColor,
      originalOrange: _firstOrange,
      ...first
    } = logoAvatarTraits("bot-1", "orange");
    const {
      color: _secondColor,
      originalOrange: _secondOrange,
      ...second
    } = logoAvatarTraits("bot-1", "blue");
    expect(first).toEqual(second);
    expect(logoAvatarTraits("bot-1", "blue").color).toBe("#3B82F6");
    expect(logoAvatarTraits("bot-1", "#abc").color).toBe("#abc");
  });
});
