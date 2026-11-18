import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

test("inlines page-runtime.js and mermaid.js as standalone lazy chunks without node_modules at runtime", async () => {
  const apiDir = path.join(root, "apps/api");
  const outDir = await mkdtemp(path.join(root, ".build-server-assets-"));
  const isolated = await mkdtemp(path.join(path.dirname(root), "vnbot-isolated-assets-"));
  const previous = process.cwd();
  try {
    process.chdir(apiDir);
    await buildInlineServer(["src/script-assets.ts"], outDir);
    process.chdir(previous);

    // Move built output outside the repository so Node cannot resolve any workspace or pnpm package.
    const movedDist = path.join(isolated, "dist");
    await mkdir(movedDist, { recursive: true });
    for (const file of await readdir(outDir, { recursive: true, withFileTypes: true })) {
      const rel = path.relative(outDir, path.join(file.parentPath, file.name));
      const dest = path.join(movedDist, rel);
      if (file.isDirectory()) await mkdir(dest, { recursive: true });
      else if (file.isFile()) {
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, await readFile(path.join(file.parentPath, file.name)));
      }
    }

    const { Hono } = await import(
      pathToFileURL(
        createRequire(path.join(apiDir, "package.json")).resolve("hono"),
      ).href
    );
    const { mountScriptAssets, DIAGRAM_SCRIPT_PATH } = await import(
      pathToFileURL(path.join(movedDist, "script-assets.js")).href
    );
    const app = new Hono();
    mountScriptAssets(app);

    const runtimeRes = await app.request("/api/v1/assets/page-runtime.js");
    assert.equal(runtimeRes.status, 200);
    const runtimeBody = await runtimeRes.text();
    assert.ok(runtimeBody.includes("RakazoPage"));

    const mermaidRes = await app.request(DIAGRAM_SCRIPT_PATH);
    assert.equal(mermaidRes.status, 200);
    const mermaidBody = await mermaidRes.text();
    assert.ok(mermaidBody.includes('globalThis["mermaid"]'));
  } finally {
    process.chdir(previous);
    await rm(outDir, { recursive: true, force: true });
    await rm(isolated, { recursive: true, force: true });
  }
});
