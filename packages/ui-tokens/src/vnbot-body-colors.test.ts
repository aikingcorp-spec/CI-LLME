import { describe, expect, it } from "vitest";
import { vnbotBodyColors } from "./index.js";

describe("vnbotBodyColors", () => {
  it("lists the twelve palette body colours with tone", () => {
    expect(vnbotBodyColors.map(({ key, hex, tone }) => ({ key, hex, tone }))).toEqual([
      { key: "la-ma", hex: "#93A460", tone: "dark" },
      { key: "la-dong", hex: "#6C763D", tone: "dark" },
      { key: "kem-lua", hex: "#F3E1C9", tone: "light" },
      { key: "cham-ran", hex: "#4D5A80", tone: "dark" },
      { key: "hong-sen", hex: "#F1A4A4", tone: "light" },
      { key: "do-son", hex: "#C8322B", tone: "dark" },
      { key: "vang-nghe", hex: "#F2B705", tone: "light" },
      { key: "xanh-ma", hex: "#7BC043", tone: "light" },
      { key: "xanh-ngoc", hex: "#1FA7A0", tone: "dark" },
      { key: "cam-gach", hex: "#E8743B", tone: "dark" },
      { key: "nau-ca-phe", hex: "#A8714B", tone: "dark" },
      { key: "cham", hex: "#5566B0", tone: "dark" },
    ]);
  });
});
