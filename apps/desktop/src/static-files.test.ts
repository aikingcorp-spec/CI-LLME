import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const desktopRoot = new URL("..", import.meta.url);

describe("desktop setup assets", () => {
  it("copies every local script and stylesheet referenced by setup.html", async () => {
    const [html, copyScript] = await Promise.all([
      readFile(new URL("src/setup.html", desktopRoot), "utf8"),
      readFile(new URL("scripts/copy-static.mjs", desktopRoot), "utf8"),
    ]);

    const staticFiles = copyScript.match(/const STATIC_FILES = \[([^\]]*)\]/)?.[1] ?? "";
    const copiedAssets = new Set([
      ...[...staticFiles.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
      ...[...copyScript.matchAll(/copyFile\(TOKENS_FILE, path\.join\(dist, "([^"]+)"\)\)/g)].map(
        (match) => match[1],
      ),
    ]);
    const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((reference) => !/^(?:[a-z]+:|\/\/|\/|#)/i.test(reference));

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(copiedAssets.has(reference), `${reference} is copied into desktop dist`).toBe(true);
    }
  });
});
