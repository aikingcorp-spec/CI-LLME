import { readFileSync } from "node:fs";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";
import { UI_LOCALES } from "./ui-locale";

it.each(UI_LOCALES)("has every pairing-screen translation in %s", async (locale) => {
  const catalog = await formatter().parse(
    readFileSync(new URL(`../locales/${locale}/messages.po`, import.meta.url), "utf8"),
    { filename: "messages.po", locale, sourceLocale: "en" },
  );
  const entries = Object.entries(catalog).filter(([, entry]) =>
    entry.origin?.some(([file]) => file === "src/pages/Pairing.tsx"),
  );
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.filter(([, entry]) => !entry.translation?.trim()).map(([id]) => id)).toEqual([]);
});
