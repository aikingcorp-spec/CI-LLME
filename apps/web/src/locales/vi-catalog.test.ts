import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM guard script without type declarations
import { findUntranslated, loadAllowSame } from "../../scripts/check-vi-catalog.mjs";

type Missing = { source: string; reason: "empty" | "same-as-en"; origin: string };
const allow: Set<string> = loadAllowSame();
const po = (id: string, str: string) =>
  `msgid ""\nmsgstr ""\n"Language: vi\\n"\n\nmsgid "${id}"\nmsgstr "${str}"\n`;

describe("intl:check-vi", () => {
  it("has a Vietnamese translation for every catalog message", async () => {
    const missing: Missing[] = await findUntranslated(
      readFileSync(new URL("./vi/messages.po", import.meta.url), "utf8"),
      allow,
    );
    expect(missing, "Untranslated Vietnamese msgstr entries").toEqual([]);
  });

  it("fails on an empty msgstr", async () => {
    const missing: Missing[] = await findUntranslated(po("Go home", ""), allow);
    expect(missing.map((m) => m.reason)).toEqual(["empty"]);
  });

  it("fails when msgstr equals the English msgid", async () => {
    const missing: Missing[] = await findUntranslated(
      po("Message {name}", "Message {name}"),
      allow,
    );
    expect(missing.map((m) => m.reason)).toEqual(["same-as-en"]);
  });

  it("allows identical strings listed in vi-allow-same.json", async () => {
    expect(allow.has("OAuth")).toBe(true);
    expect(await findUntranslated(po("OAuth", "OAuth"), allow)).toEqual([]);
  });
});
