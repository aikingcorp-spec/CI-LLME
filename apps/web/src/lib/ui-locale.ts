import { AppLocaleSchema } from "@rakazo/contracts";
import { APP_LOCALE_LABELS, matchUiLocale } from "@rakazo/core";
import { readableLocalStorage } from "./stored-preference";

export const UI_LOCALES = AppLocaleSchema.options;

export type UiLocale = (typeof UI_LOCALES)[number];

/** Languages a person can choose. Catalogs for other tags stay so a saved choice still resolves. */
const OFFERED_UI_LOCALES = ["vi", "en"] as const satisfies readonly UiLocale[];

/** The designed picker. Other catalogs stay so a saved tag still has a name. */
export const PICKER_LOCALES = OFFERED_UI_LOCALES;

export const UI_LOCALE_LABELS = APP_LOCALE_LABELS;

export function offeredUiLocales(current: UiLocale | null | undefined): UiLocale[] {
  if (current && !OFFERED_UI_LOCALES.includes(current as (typeof OFFERED_UI_LOCALES)[number])) {
    return [current, ...OFFERED_UI_LOCALES];
  }
  return [...OFFERED_UI_LOCALES];
}

export const UI_LOCALE_STORAGE_KEY = "rakazo.uiLocale";

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
  navigatorLanguage?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
  env?: { VITE_DEFAULT_UI_LOCALE?: string };
  navigator?: Pick<Navigator, "language" | "languages"> | null;
};

/**
 * Order: saved choice → `VITE_DEFAULT_UI_LOCALE` → Vietnamese.
 * A new install does not follow the browser language.
 */
export function resolveUiLocale(options: ResolveUiLocaleOptions = {}): UiLocale {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredLocale(options.storage ?? readableLocalStorage());
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
  if (envDefault) return normalizeUiLocale(envDefault);

  return "vi";
}

export function persistUiLocale(
  locale: UiLocale,
  storage: Pick<Storage, "setItem"> | null = readableLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_LOCALE_STORAGE_KEY, locale);
  } catch {
    // Ignore quota / private-mode failures; in-memory locale still applies.
  }
}
