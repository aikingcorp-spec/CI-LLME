import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildInlineServer, staysExternal } from "./build-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("keeps packages that find their own files, and one copy of pg, outside the bundle", () => {
  for (const name of ["koffi", "pg", "@prisma/client", "@prisma/adapter-pg", "sharp", "jsdom"])
    assert.equal(staysExternal(name), true, name);
  for (const name of ["pg-protocol", "lodash", "@prismatic/x", "zod/v4"])
    assert.equal(staysExternal(name), false, name);
});

test("links an external package by its path from every output file", async () => {
  // Inside the repository, so packages resolve from its node_modules.
  const dir = await mkdtemp(path.join(root, ".build-server-test-"));
  try {
    await mkdir(path.join(dir, "src/cli"), { recursive: true });
    const uses = 'import { version } from "esbuild";\nexport const used = version;\n';
    await writeFile(path.join(dir, "src/shared.ts"), uses);
    await writeFile(
      path.join(dir, "src/index.ts"),
      'export { used } from "./shared.ts";\nexport const lazy = () => import("./shared.ts");\n',
    );
    await writeFile(
      path.join(dir, "src/cli/tool.ts"),
      `${uses}export { used as again } from "../shared.ts";\n`,
    );
    const previous = process.cwd();
    process.chdir(dir);
    try {
      await buildInlineServer(["src/index.ts", "src/cli/tool.ts"], path.join(dir, "dist"));
    } finally {
      process.chdir(previous);
    }
    const files = (await readdir(path.join(dir, "dist"), { recursive: true }))
      .filter((file) => file.endsWith(".js"))
      .map((file) => path.join("dist", file));
    assert.ok(files.includes(path.join("dist", "cli", "tool.js")));
    let linked = 0;
    for (const file of files) {
      const text = await readFile(path.join(dir, file), "utf8");
      assert.doesNotMatch(text, /vnbot-external:/);
      const specifiers = [...text.matchAll(/from\s*"(\.[^"]*node_modules[^"]*)"/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        assert.ok(await stat(path.resolve(path.dirname(path.join(dir, file)), specifier)));
        linked += 1;
      }
    }
    assert.ok(linked >= 2, "an output file in dist and one in dist/cli import the package");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
