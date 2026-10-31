import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { hydratePostgresSymlinks } = require("../scripts/after-pack.cjs");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function packageDir(name: string) {
  const appOutDir = await mkdtemp(path.join(tmpdir(), "desktop-after-pack-"));
  dirs.push(appOutDir);
  const root = path.join(
    appOutDir,
    "resources/app.asar.unpacked/node_modules/@embedded-postgres",
    name,
  );
  await mkdir(path.join(root, "native/lib"), { recursive: true });
  return { appOutDir, root };
}

describe("embedded Postgres package hydration", () => {
  it("creates relative links once and preserves existing targets", async () => {
    const { appOutDir, root } = await packageDir("linux-x64");
    await writeFile(path.join(root, "native/lib/libicuuc.so.60.2"), "library");
    await writeFile(
      path.join(root, "native/pg-symlinks.json"),
      JSON.stringify([
        { source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so.60" },
        { source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so" },
      ]),
    );
    await symlink("libicuuc.so.60.2", path.join(root, "native/lib/libicuuc.so"));

    await hydratePostgresSymlinks(appOutDir);
    await hydratePostgresSymlinks(appOutDir);

    expect(await readlink(path.join(root, "native/lib/libicuuc.so.60"))).toBe("libicuuc.so.60.2");
    expect(await readlink(path.join(root, "native/lib/libicuuc.so"))).toBe("libicuuc.so.60.2");
  });

  it("rejects paths outside the package", async () => {
    const { appOutDir, root } = await packageDir("linux-x64");
    await writeFile(
      path.join(root, "native/pg-symlinks.json"),
      JSON.stringify([{ source: "../../outside", target: "native/lib/libicuuc.so.60" }]),
    );

    await expect(hydratePostgresSymlinks(appOutDir)).rejects.toThrow(/outside|escape/i);
  });

  it("skips Windows packages and packages without a manifest", async () => {
    const { appOutDir, root } = await packageDir("windows-x64");
    await writeFile(
      path.join(root, "native/pg-symlinks.json"),
      JSON.stringify([{ source: "../../outside", target: "native/lib/missing" }]),
    );
    await mkdir(path.join(path.dirname(root), "linux-arm64", "native"), { recursive: true });

    await expect(hydratePostgresSymlinks(appOutDir)).resolves.toBeUndefined();
  });

  it("rejects a target directory that is itself a symlink outside the package", async () => {
    const { appOutDir, root } = await packageDir("linux-x64");
    await writeFile(path.join(root, "native/lib/source.so"), "library");
    const outside = path.join(appOutDir, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(root, "native/external"));
    await writeFile(
      path.join(root, "native/pg-symlinks.json"),
      JSON.stringify([{ source: "native/lib/source.so", target: "native/external/target.so" }]),
    );

    await expect(hydratePostgresSymlinks(appOutDir)).rejects.toThrow(/escape/i);
  });
});
