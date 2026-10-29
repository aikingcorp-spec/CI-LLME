import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeUiLocale,
  persistUiLocale,
  resolveUiLocale,
  UI_LOCALE_STORAGE_KEY,
} from "./ui-locale";

describe("normalizeUiLocale", () => {
  it("maps regional tags onto supported locales", () => {
    expect(normalizeUiLocale("de-DE")).toBe("de");
    expect(normalizeUiLocale("ko-KR")).toBe("ko");
    expect(normalizeUiLocale("en-US")).toBe("en");
    expect(normalizeUiLocale("pt-BR")).toBe("pt-BR");
    expect(normalizeUiLocale("pt")).toBe("pt-BR");
    expect(normalizeUiLocale("hi-IN")).toBe("hi");
    expect(normalizeUiLocale("DE")).toBe("de");
    expect(normalizeUiLocale("es")).toBe("es");
    expect(normalizeUiLocale("es-ES")).toBe("es");
    expect(normalizeUiLocale("es-MX")).toBe("es");
    expect(normalizeUiLocale("es-419")).toBe("es");
    expect(normalizeUiLocale("ES")).toBe("es");
    expect(normalizeUiLocale("es_AR")).toBe("es");
    expect(normalizeUiLocale("ru-RU")).toBe("ru");
    expect(normalizeUiLocale("ru_KZ")).toBe("ru");
    expect(normalizeUiLocale(" RU ")).toBe("ru");
    expect(normalizeUiLocale("fr")).toBe("fr");
    expect(normalizeUiLocale("fr-FR")).toBe("fr");
    expect(normalizeUiLocale("fr-CA")).toBe("fr");
    expect(normalizeUiLocale("FR")).toBe("fr");
    expect(normalizeUiLocale("fr_BE")).toBe("fr");
    expect(normalizeUiLocale("he")).toBe("he");
    expect(normalizeUiLocale("he-IL")).toBe("he");
    expect(normalizeUiLocale("HE")).toBe("he");
    expect(normalizeUiLocale("he_IL")).toBe("he");
    expect(normalizeUiLocale("nl")).toBe("nl");
    expect(normalizeUiLocale("nl-NL")).toBe("nl");
    expect(normalizeUiLocale("nl-BE")).toBe("nl");
    expect(normalizeUiLocale("NL")).toBe("nl");
    expect(normalizeUiLocale("nl_nl")).toBe("nl");
    expect(normalizeUiLocale("ja")).toBe("ja");
    expect(normalizeUiLocale("ja-JP")).toBe("ja");
    expect(normalizeUiLocale("ja_JP")).toBe("ja");
    expect(normalizeUiLocale("iw")).toBe("he");
    expect(normalizeUiLocale("iw-IL")).toBe("he");
    expect(normalizeUiLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-SG")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_cn")).toBe("zh-CN");
    expect(normalizeUiLocale("ZH-cn")).toBe("zh-CN");
    expect(normalizeUiLocale(" zh-CN ")).toBe("zh-CN");
    expect(normalizeUiLocale("zh_Hans_CN")).toBe("zh-CN");
  });

  it.each([
    "zh-TW",
    "zh_TW",
    " ZH-tw ",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
    "zh-TW-u-nu-hanidec",
    "zh-Hant-CN",
  ])("maps %s to Traditional Chinese", (tag) => expect(normalizeUiLocale(tag)).toBe("zh-TW"));

  it("honors an explicit Simplified script in Traditional Chinese regions", () => {
    expect(normalizeUiLocale("zh-Hans-TW")).toBe("zh-CN");
    expect(normalizeUiLocale("zh-Hans-HK")).toBe("zh-CN");
    expect(normalizeUiLocale("en-TW")).toBe("en");
    expect(normalizeUiLocale("de-HK")).toBe("de");
  });

  it("accepts Vietnamese and its region tag", () => {
    expect(normalizeUiLocale("vi")).toBe("vi");
    expect(normalizeUiLocale("vi-VN")).toBe("vi");
  });

  it("falls back to English for unknown locales", () => {
    expect(normalizeUiLocale("sv-SE")).toBe("en");
    expect(normalizeUiLocale("")).toBe("en");
    expect(normalizeUiLocale(null)).toBe("en");
  });
});

describe("resolveUiLocale", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers saved English even with a Vietnamese env default", () => {
    expect(resolveUiLocale({ stored: "en", envDefault: "vi" })).toBe("en");
  });

  it("keeps saved-choice normalization unchanged", () => {
    expect(resolveUiLocale({ stored: "sv-SE", envDefault: "vi" })).toBe("en");
  });

  it("defaults to Vietnamese in an English browser with no saved preference", () => {
    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
    expect(resolveUiLocale({ stored: null, envDefault: "vi" })).toBe("vi");
  });

  it.each([
    ["de-AT", "de"],
    ["en", "en"],
    [" en-US ", "en"],
    ["zh-TW", "zh-TW"],
  ])("uses supported env override %s when nothing is saved", (envDefault, expected) => {
    expect(resolveUiLocale({ stored: null, envDefault })).toBe(expected);
  });

  it("defaults to Vietnamese when the env is unset", () => {
    expect(resolveUiLocale({ stored: null, env: {} })).toBe("vi");
  });

  it("defaults to Vietnamese when the env is unset and navigator is en-US", () => {
    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
    expect(resolveUiLocale({ stored: null, env: {} })).toBe("vi");
  });

  it.each([null, "", "   ", "sv-SE", "garbage", "english"])(
    "defaults to Vietnamese for missing or unsupported env value %s",
    (envDefault) => {
      expect(resolveUiLocale({ stored: null, envDefault })).toBe("vi");
    },
  );

  it("reads localStorage via the storage helper", () => {
    const storage = {
      getItem: (key: string) => (key === UI_LOCALE_STORAGE_KEY ? "de" : null),
    };
    expect(resolveUiLocale({ storage, envDefault: null })).toBe("de");
  });
});

it("ships Vietnamese as the web build default", () => {
  for (const file of [
    "../../../../.env.example",
    "../../.env.development",
    "../../.env.production",
  ]) {
    expect(readFileSync(new URL(file, import.meta.url), "utf8")).toMatch(
      /^VITE_DEFAULT_UI_LOCALE=vi$/m,
    );
  }
});

it("passes the Vietnamese default into the Docker web build", () => {
  // .dockerignore drops .env.production from the image context, so the Dockerfile must carry it.
  const dockerfile = readFileSync(
    new URL("../../../../infra/compose/Dockerfile", import.meta.url),
    "utf8",
  );
  expect(dockerfile).toMatch(/^ARG VITE_DEFAULT_UI_LOCALE=vi$/m);
  const viteEnv = readFileSync(new URL("../vite-env.d.ts", import.meta.url), "utf8");
  for (const [, name] of viteEnv.matchAll(/readonly (VITE_[A-Z0-9_]+)/g)) {
    expect(dockerfile).toMatch(new RegExp(`^ARG ${name}=`, "m"));
  }
});

describe("persistUiLocale", () => {
  it("writes the storage key", () => {
    const store = new Map<string, string>();
    persistUiLocale("ko", {
      setItem: (key, value) => {
        store.set(key, value);
      },
    });
    expect(store.get(UI_LOCALE_STORAGE_KEY)).toBe("ko");
  });
});

describe("Traditional Chinese preferences", () => {
  it("lets a saved choice override the configured default", () => {
    expect(resolveUiLocale({ stored: "zh-TW", envDefault: "en" })).toBe("zh-TW");
    expect(resolveUiLocale({ stored: "zh-CN", envDefault: "zh-TW" })).toBe("zh-CN");
    expect(resolveUiLocale({ stored: null, envDefault: "zh-TW" })).toBe("zh-TW");
  });
});
