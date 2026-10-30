import { describe, expect, it } from "vitest";
import { currentLocale, format, resolveLocale, setLocale, strings, stringsFor } from "./strings.js";

const FORBIDDEN =
  /rakazo|github|open[- ]?source|wallet|paywall|upgrade|pricing|(?<!\p{L})(nâng cấp|ví tiền|giá)(?!\p{L})/iu;

function leaves(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("resolveLocale", () => {
  it("uses Vietnamese for vi locales and when no locale is known", () => {
    expect(resolveLocale("vi")).toBe("vi");
    expect(resolveLocale("vi-VN")).toBe("vi");
    expect(resolveLocale("VI")).toBe("vi");
    expect(resolveLocale(undefined)).toBe("vi");
    expect(resolveLocale("")).toBe("vi");
  });

  it("falls back to English for every other locale", () => {
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale("ja")).toBe("en");
  });

  it("switches the active dictionary", () => {
    try {
      expect(setLocale("en-GB")).toBe("en");
      expect(currentLocale()).toBe("en");
      expect(strings().menu.file).toBe("File");
      expect(setLocale("vi-VN")).toBe("vi");
      expect(strings().menu.file).toBe("Tệp");
    } finally {
      setLocale(undefined);
    }
  });
});

describe("dictionary", () => {
  it("has the same keys and placeholders in both languages", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const vi = new Map(leaves(stringsFor("vi")));
    const en = new Map(leaves(stringsFor("en")));
    expect([...en.keys()].sort()).toEqual([...vi.keys()].sort());
    for (const [key, text] of vi) {
      expect(text.trim(), key).not.toBe("");
      expect(placeholders(text), key).toEqual(placeholders(en.get(key) ?? ""));
    }
  });

  it("keeps the brand and avoids forbidden product copy", () => {
    for (const locale of ["vi", "en"] as const) {
      for (const [key, text] of leaves(stringsFor(locale))) {
        expect(text, `${locale}.${key}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("translates the visible Vietnamese copy", () => {
    const vi = new Map(leaves(stringsFor("vi")));
    const en = new Map(leaves(stringsFor("en")));
    const same = [...vi].filter(([key, text]) => text === en.get(key) && /[a-z]{4}/.test(text));
    expect(same.map(([key]) => key).sort()).toEqual(["setup.modeCloud", "setup.serverPlaceholder"]);
  });
});

describe("format", () => {
  it("fills named placeholders and leaves unknown ones", () => {
    expect(format("{a} và {b} {c}", { a: 1, b: "x" })).toBe("1 và x {c}");
  });
});
