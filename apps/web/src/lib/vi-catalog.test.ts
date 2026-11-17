import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function blockFor(catalog: string, id: string): string | undefined {
  return catalog.split("\n\n").find((block) => block.includes(`msgid ${JSON.stringify(id)}\n`));
}

function msgstr(block: string | undefined): string | undefined {
  const raw = block?.match(/^msgstr (".*")$/m)?.[1];
  return raw === undefined ? undefined : (JSON.parse(raw) as string);
}

/** Placeholder names, such as `count` and `peer` in an ICU plural. */
function placeholders(text: string): string[] {
  // Vietnamese has one plural form, so a name may appear fewer times than in English.
  return [...new Set([...text.matchAll(/\{(\w+)(?:[,}])/g)].map((match) => match[1] ?? ""))].sort();
}

describe("Vietnamese catalog", () => {
  const catalog = readFileSync(
    new URL("../../../../packages/i18n/locales/vi/messages.po", import.meta.url),
    "utf8",
  );
  const entries = catalog
    .split("\n\n")
    .map((block) => ({ id: block.match(/^msgid (".+")$/m)?.[1], text: msgstr(block) }))
    .filter((entry): entry is { id: string; text: string | undefined } => Boolean(entry.id));

  it("keeps the reviewed 0.3.9 translations", () => {
    expect(msgstr(blockFor(catalog, "Close"))).toBe("Đóng");
    expect(msgstr(blockFor(catalog, "Return to VNBot"))).toBe("Quay lại VNBot");
    expect(msgstr(blockFor(catalog, "Advanced"))).toBe("Nâng cao");
  });

  // Owner decision 2026-11-12 (S00 item 7): every label reads in plain Vietnamese.
  it("leaves no string untranslated and keeps every placeholder", () => {
    expect(entries.length).toBeGreaterThan(1000);
    const untranslated = entries.filter((entry) => !entry.text).map((entry) => entry.id);
    expect(untranslated).toEqual([]);
    const mismatched = entries
      .filter((entry) => {
        const id = JSON.parse(entry.id) as string;
        return placeholders(id).join() !== placeholders(entry.text ?? "").join();
      })
      .map((entry) => entry.id);
    expect(mismatched).toEqual([]);
  });
});
