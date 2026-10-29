import { matchUiLocale } from "@rakazo/core";

export const UI_LOCALES = [
  "vi",
  "en",
  "de",
  "ko",
  "tr",
  "hi",
  "pt-BR",
  "zh-CN",
  "zh-TW",
  "es",
  "ru",
  "fr",
  "he",
  "nl",
  "ja",
] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  vi: "Tiếng Việt",
  en: "English",
  de: "Deutsch",
  ko: "한국어",
  tr: "Türkçe",
  hi: "हिन्दी",
  "pt-BR": "Português (Brasil)",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  es: "Español",
  ru: "Русский",
  fr: "Français",
  he: "עברית",
  nl: "Nederlands",
  ja: "日本語",
};

/** Normalize BCP-47 tags (`de-DE`, `ko-KR`, `pt-BR`, `zh-CN`, `es-ES`) to a supported UI locale, else `en`. */
export function normalizeUiLocale(raw: string | null | undefined): UiLocale {
  return matchUiLocale(raw, UI_LOCALES);
}

function readStoredLocale(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readEnvDefault(env: { VITE_DEFAULT_UI_LOCALE?: string } | undefined): string | null {
  const value = env?.VITE_DEFAULT_UI_LOCALE;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type ResolveUiLocaleOptions = {
  stored?: string | null;
  envDefault?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
  env?: { VITE_DEFAULT_UI_LOCALE?: string };
};

/**
 * Order: saved choice (`localStorage`) → valid `VITE_DEFAULT_UI_LOCALE` → Vietnamese.
 * Browser language never overrides the default.
 */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredLocale(
          options.storage ?? (typeof localStorage !== "undefined" ? localStorage : null),
        );
  if (stored) return normalizeUiLocale(stored);

  const envDefault =
    options.envDefault !== undefined
      ? options.envDefault
      : readEnvDefault(
          options.env ??
            (typeof import.meta !== "undefined"
              ? {
                  VITE_DEFAULT_UI_LOCALE: (import.meta as ImportMeta).env?.VITE_DEFAULT_UI_LOCALE,
                }
              : undefined),
        );
  if (envDefault) {
    const locale = normalizeUiLocale(envDefault);
    // The shared normalizer also returns English for unsupported values.
    const language = envDefault.trim().toLowerCase().split(/[-_]/)[0];
    if (locale !== "en" || language === "en") return locale;
  }

  return "vi";
}

export function persistUiLocale(
  locale: UiLocale,
  storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore quota / private-mode failures; in-memory locale still applies.
  }
}
