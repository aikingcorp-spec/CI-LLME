#!/usr/bin/env node
// Guard: every Vietnamese msgstr must be non-empty and differ from the English msgid,
// except strings listed in src/locales/vi-allow-same.json (brands, units, code tokens).
// Usage: node scripts/check-vi-catalog.mjs [path/to/messages.po]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export function loadAllowSame(path = here("../src/locales/vi-allow-same.json")) {
  return new Set(JSON.parse(readFileSync(path, "utf8")).allow);
}

/** Returns untranslated entries: [{ source, reason, origin }]. */
export async function findUntranslated(poText, allow) {
  const catalog = await formatter().parse(poText, {
    filename: "messages.po",
    locale: "vi",
    sourceLocale: "en",
  });
  return Object.entries(catalog).flatMap(([id, entry]) => {
    const source = entry.message || id;
    const origin = entry.origin?.[0]?.filter(Boolean).join(":") ?? "";
    const translation = entry.translation?.trim();
    if (!translation) return [{ source, reason: "empty", origin }];
    const literal = source.replace(/\{[^{}]*\}/gu, "").trim();
    if (!/\p{L}/u.test(literal) || allow.has(literal)) return [];
    return translation === source.trim() ? [{ source, reason: "same-as-en", origin }] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const poPath = process.argv[2] ?? here("../src/locales/vi/messages.po");
  const missing = await findUntranslated(readFileSync(poPath, "utf8"), loadAllowSame());
  if (missing.length === 0) {
    console.log("vi catalog: OK");
  } else {
    const empty = missing.filter((m) => m.reason === "empty").length;
    console.error(
      `vi catalog: ${missing.length} chuỗi chưa dịch (${empty} trống, ${missing.length - empty} trùng tiếng Anh).`,
    );
    for (const m of missing.slice(0, 20)) {
      console.error(
        `  [${m.reason}] ${JSON.stringify(m.source)}${m.origin ? ` (${m.origin})` : ""}`,
      );
    }
    console.error(
      "Dịch trong apps/web/src/locales/vi/messages.po hoặc thêm vào apps/web/src/locales/vi-allow-same.json kèm lý do.",
    );
    process.exit(1);
  }
}
