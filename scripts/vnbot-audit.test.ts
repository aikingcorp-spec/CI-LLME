import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { catalogBrandLeaks, htmlBrandLeaks, screenInventory } from "./vnbot-audit";

it("checks translated text and English fallbacks, not renamed msgids or obsolete entries", () => {
  assert.deepEqual(
    catalogBrandLeaks(
      'msgid "Rakazo"\nmsgstr "VNBot"\n\nmsgid "Rakazo fallback"\nmsgstr ""\n\nmsgid "rakazo-shared and IDs starting with bot- are reserved for VNBot."\nmsgstr ""\n\nmsgid "rakazo-shared and IDs starting with bot- are reserved for Rakazo."\nmsgstr ""\n\n#~ msgid "Rakazo old"\n#~ msgstr "Rakazo"',
    ),
    ["Rakazo fallback", "rakazo-shared and IDs starting with bot- are reserved for Rakazo."],
  );
});
it("checks multiline translations and contexts", () => {
  assert.deepEqual(catalogBrandLeaks('msgctxt "title"\nmsgid "Hello"\nmsgstr "Open "\n"Rakazo"'), [
    "title\u0004Hello",
  ]);
});
it("finds labels and text without confusing technical script keys or resource URLs", () => {
  assert.deepEqual(
    htmlBrandLeaks(
      '<script>window.rakazoDesktop={}</script><img src="/rakazo-compat.svg" alt="VNBot"><p>VNBot</p>',
    ),
    [],
  );
  assert.deepEqual(htmlBrandLeaks('<input placeholder="Rakazo"><p>/home/rakazo</p>').length, 2);
});
it("lists changed and missing UI source without claiming visual parity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vnbot-audit-"));
  try {
    for (const tree of ["old", "current"])
      for (const dir of ["apps/web/src/pages", "apps/web/src/components", "apps/desktop/src"])
        await mkdir(path.join(root, tree, dir), { recursive: true });
    for (const tree of ["old", "current"])
      await writeFile(path.join(root, tree, "apps/web/src/pages/Welcome.tsx"), "same");
    await writeFile(path.join(root, "old/apps/web/src/pages/Auth.tsx"), "old");
    await writeFile(path.join(root, "current/apps/web/src/pages/Auth.tsx"), "changed");
    await writeFile(path.join(root, "old/apps/desktop/src/splash.html"), "missing");
    await writeFile(path.join(root, "old/apps/web/src/pages/Auth.test.tsx"), "ignore");
    await writeFile(path.join(root, "old/apps/web/src/pages/Pairing.tsx"), "removed");
    assert.deepEqual(await screenInventory(path.join(root, "old"), path.join(root, "current")), [
      { file: "apps/web/src/pages/Auth.tsx", state: "changed-source" },
      {
        file: "apps/web/src/pages/Pairing.tsx",
        state: "removed-by-S00",
        reason: "S00 removes P2P pairing.",
      },
      { file: "apps/web/src/pages/Welcome.tsx", state: "identical-source" },
      { file: "apps/desktop/src/splash.html", state: "missing" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
