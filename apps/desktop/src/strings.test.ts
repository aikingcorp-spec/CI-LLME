import { describe, expect, it } from "vitest";
import {
  currentLocale,
  format,
  localeFromSavedChoice,
  resolveLocale,
  setLocale,
  strings,
  stringsFor,
} from "./strings.js";

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

describe("localeFromSavedChoice", () => {
  it("is Vietnamese until the person saves another language", () => {
    expect(localeFromSavedChoice(null)).toBe("vi");
    expect(localeFromSavedChoice(undefined)).toBe("vi");
    expect(localeFromSavedChoice("")).toBe("vi");
    expect(localeFromSavedChoice("vi")).toBe("vi");
  });

  it("follows an English choice and ignores the operating system language", () => {
    expect(localeFromSavedChoice("en")).toBe("en");
    expect(localeFromSavedChoice("de")).toBe("en");
  });

  it("moves retired catalogs to Vietnamese like the web app", () => {
    for (const saved of ["ja", "ko", "zh-CN", "zh-TW"])
      expect(localeFromSavedChoice(saved)).toBe("vi");
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

  it("has the sign-in and machine steps in both languages", () => {
    const stepKeys = [
      "subheadingEmail",
      "subheadingCode",
      "emailLabel",
      "sendCode",
      "codeLabel",
      "verifyCode",
      "resendCode",
      "changeEmail",
      "sendingCode",
      "verifyingCode",
      "codeResent",
      "enterEmail",
      "enterCode",
      "otpInvalid",
      "otpExpired",
      "otpNotInvited",
      "otpRateLimited",
      "otpNetwork",
      "otpFailed",
      "comingSoon",
    ] as const;
    for (const locale of ["vi", "en"] as const) {
      const text = stringsFor(locale).setup;
      for (const key of stepKeys) expect(text[key], `${locale}.${key}`).toBeTruthy();
    }
    const vi = stringsFor("vi").setup;
    expect([vi.sendCode, vi.verifyCode, vi.resendCode, vi.changeEmail]).toEqual([
      "Gửi mã",
      "Xác nhận",
      "Gửi lại mã",
      "Đổi email",
    ]);
    expect(vi.modeNew).toBe("Máy tính này");
    expect(vi.modeExisting).toBe("Máy của bạn (VPS, Mac mini, máy chủ riêng…)");
    expect(vi.comingSoon).toBe("Sắp có");
    const en = stringsFor("en").setup;
    expect(en.modeExisting).toBe("Your own machine (VPS, Mac mini, any server)");
    expect(en.comingSoon).toBe("Coming soon");
  });

  it("keeps the brand and avoids forbidden product copy", () => {
    for (const locale of ["vi", "en"] as const) {
      for (const [key, text] of leaves(stringsFor(locale))) {
        expect(text, `${locale}.${key}`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("has natural Vietnamese menu labels with no English leftovers", () => {
    const menu = stringsFor("vi").menu;
    expect(menu.revokeComputerAccess).toBe("Thu hồi quyền dùng máy tính này");
    expect(menu.stopLocalStack).toBe("Dừng VNBot trên máy này");
    for (const [key, text] of leaves(menu)) {
      expect(text, `menu.${key}`).not.toMatch(
        /\b(Revoke|Local|Stack|Stop|Computer|Access|Undo|Cut|Paste|Quit|Close)\b/,
      );
    }
  });

  it("translates the visible Vietnamese copy", () => {
    const vi = new Map(leaves(stringsFor("vi")));
    const en = new Map(leaves(stringsFor("en")));
    const same = [...vi].filter(([key, text]) => text === en.get(key) && /[a-z]{4}/.test(text));
    expect(same.map(([key]) => key).sort()).toEqual([
      "setup.emailLabel",
      "setup.modeCloud",
      "setup.serverPlaceholder",
    ]);
  });
});

describe("format", () => {
  it("fills named placeholders and leaves unknown ones", () => {
    expect(format("{a} và {b} {c}", { a: 1, b: "x" })).toBe("1 và x {c}");
  });
});
