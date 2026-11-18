import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  assembleNativeBundle,
  parseNativeBuildArgs,
  vendorWindowsRuntimeDlls,
} from "../../scripts/build-native.mjs";
import { nativeBundleManifest } from "./native-stack.js";

const execFile = promisify(execFileCallback);

async function executable(file: string, body: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await chmod(file, 0o755);
}

async function fixtureRepo() {
  const parent = path.resolve(import.meta.dirname, "../../build/native-bundle-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));
  const repo = path.join(root, "repo");
  const output = path.join(root, "out");
  const node = path.join(root, "node");
  const postgres = path.join(root, "postgres");
  await executable(node, `#!/bin/sh\nprintf '%s\\n' '${process.platform}/${process.arch}'\n`);
  await executable(
    path.join(postgres, "bin", "postgres"),
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'postgres (PostgreSQL) 18.2'; fi\n",
  );
  await executable(path.join(postgres, "bin", "initdb"), "#!/bin/sh\n");
  await mkdir(path.join(postgres, "lib"), { recursive: true });
  await mkdir(path.join(postgres, "share"), { recursive: true });
  await writeFile(path.join(postgres, "lib", "libpq.so"), "lib");
  await writeFile(path.join(postgres, "share", "postgres.bki"), "bki");

  const dep = path.join(repo, "node_modules/.pnpm/dep@1.0.0/node_modules/dep");
  const pkg = path.join(repo, "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg");
  const opt = path.join(repo, "node_modules/.pnpm/opt@1.0.0/node_modules/opt");
  await mkdir(dep, { recursive: true });
  await mkdir(pkg, { recursive: true });
  await mkdir(opt, { recursive: true });
  await writeFile(path.join(dep, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(path.join(dep, "index.js"), 'export const name = "dep";\n');
  await writeFile(path.join(pkg, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(
    path.join(pkg, "index.js"),
    'import { name } from "dep";\nexport const value = name;\n',
  );
  await symlink("../../dep@1.0.0/node_modules/dep", path.join(pkg, "..", "dep"));
  await writeFile(path.join(opt, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(path.join(opt, "index.js"), "export const optional = true;\n");

  await mkdir(path.join(repo, "apps/api/dist/cli"), { recursive: true });
  await mkdir(path.join(repo, "apps/worker/dist"), { recursive: true });
  await writeFile(
    path.join(repo, "apps/api/dist/index.js"),
    [
      'import { value } from "../../../node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js";',
      'import { optional } from "../../../../outside-checkout/node_modules/.pnpm/opt@1.0.0/node_modules/opt/index.js";',
      'export const loaded = import("../../../node_modules/.pnpm/opt@1.0.0/node_modules/opt/index.js");',
      "export { value, optional };",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(repo, "apps/api/dist/cli/migrate-database.js"), "export {}\n");
  await writeFile(path.join(repo, "apps/worker/dist/index.js"), "export {}\n");
  await writeFile(
    path.join(repo, "apps/api/package.json"),
    `${JSON.stringify({ name: "@rakazo/api", type: "module" })}\n`,
  );
  await writeFile(
    path.join(repo, "apps/worker/package.json"),
    `${JSON.stringify({ name: "@rakazo/worker", type: "module" })}\n`,
  );
  await mkdir(path.join(repo, "apps/web/dist"), { recursive: true });
  await writeFile(
    path.join(repo, "apps/web/dist/index.html"),
    "<!doctype html><title>VNBot</title>\n",
  );
  await mkdir(path.join(repo, "packages/db/prisma/migrations/001_init"), { recursive: true });
  await writeFile(path.join(repo, "packages/db/prisma/schema.prisma"), "datasource db {}\n");
  await writeFile(path.join(repo, "packages/db/prisma.config.ts"), "export default {};\n");
  await writeFile(
    path.join(repo, "packages/db/prisma/migrations/001_init/migration.sql"),
    "select 1;\n",
  );
  await writeFile(
    path.join(repo, "packages/db/package.json"),
    `${JSON.stringify({
      name: "@rakazo/db",
      type: "module",
      dependencies: { dep: "1.0.0", "@rakazo/core": "workspace:*" },
    })}\n`,
  );
  await mkdir(path.join(repo, "packages/db/node_modules"), { recursive: true });
  await symlink(
    "../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep",
    path.join(repo, "packages/db/node_modules/dep"),
  );
  return { root, repo, output, node, postgres };
}

function request(fixture: Awaited<ReturnType<typeof fixtureRepo>>) {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeBinary: fixture.node,
    postgresPrefix: fixture.postgres,
    output: fixture.output,
    repoRoot: fixture.repo,
  };
}

it("rejects a native build that does not name its node and postgres inputs", async () => {
  expect(() => parseNativeBuildArgs([])).toThrow("Missing native bundle input: --node");
  const desktop = path.resolve(import.meta.dirname, "../..");
  const failed = await execFile(process.execPath, ["scripts/build-native.mjs"], {
    cwd: desktop,
  }).then(
    () => null,
    (error: { stderr?: string; code?: number }) => error,
  );
  expect(failed?.code).toBe(1);
  expect(failed?.stderr).toContain("Missing native bundle input: --node");
});

it("preserves pre-existing scratch and unrecognized output", async () => {
  const fixture = await fixtureRepo();
  try {
    for (const directory of [`${fixture.output}.staging`, `${fixture.output}.previous`]) {
      await mkdir(directory);
      const sentinel = path.join(directory, "keep.txt");
      await writeFile(sentinel, "keep");
      await expect(assembleNativeBundle(request(fixture))).rejects.toThrow(
        "Existing native build scratch requires inspection.",
      );
      expect(await readFile(sentinel, "utf8")).toBe("keep");
      await rm(directory, { recursive: true });
    }
    await mkdir(fixture.output);
    const sentinel = path.join(fixture.output, "keep.txt");
    await writeFile(sentinel, "keep");
    await expect(assembleNativeBundle(request(fixture))).rejects.toThrow(
      "Existing native output requires inspection.",
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    await expect(
      assembleNativeBundle({ ...request(fixture), output: fixture.root }),
    ).rejects.toThrow("Native bundle output overlaps its sources.");
    await expect(
      assembleNativeBundle({
        ...request(fixture),
        arch: process.arch === "arm64" ? "x64" : "arm64",
      }),
    ).rejects.toThrow("Native bundle must be assembled on its target platform and architecture.");
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("writes no manifest when a required source is missing or the probe disagrees", async () => {
  const fixture = await fixtureRepo();
  try {
    await rm(path.join(fixture.repo, "apps/web/dist/index.html"));
    await expect(assembleNativeBundle(request(fixture))).rejects.toThrow(
      "Missing native bundle source: apps/web/dist/index.html",
    );
    await expect(lstat(path.join(fixture.output, "manifest.json"))).rejects.toThrow();
    await expect(lstat(`${fixture.output}.staging`)).rejects.toThrow();

    await writeFile(path.join(fixture.repo, "apps/web/dist/index.html"), "<!doctype html>\n");
    await writeFile(fixture.node, "#!/bin/sh\nprintf '%s\\n' 'other/arch'\n");
    await chmod(fixture.node, 0o755);
    await expect(assembleNativeBundle(request(fixture))).rejects.toThrow(
      "Native Node target mismatch.",
    );
    await expect(lstat(path.join(fixture.output, "manifest.json"))).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("assembles a bundle whose imports stay inside it and replaces that bundle on the next run", async () => {
  const fixture = await fixtureRepo();
  try {
    const first = await assembleNativeBundle(request(fixture));
    const second = await assembleNativeBundle(request(fixture));
    expect(second).toBe(first);
    await expect(lstat(`${fixture.output}.staging`)).rejects.toThrow();
    await expect(lstat(`${fixture.output}.previous`)).rejects.toThrow();

    const manifest = JSON.parse(await readFile(path.join(fixture.output, "manifest.json"), "utf8"));
    const expected = nativeBundleManifest({ platform: process.platform, arch: process.arch });
    expect(manifest).toEqual(expected);
    const entry = path.join(fixture.output, "apps/api/dist/index.js");
    const source = await readFile(entry, "utf8");
    expect(source).toContain("import(");
    expect(source).not.toContain("outside-checkout");
    const linked = await realpath(
      path.join(fixture.output, "node_modules/.pnpm/pkg@1.0.0/node_modules/dep"),
    );
    expect(linked.startsWith(`${fixture.output}${path.sep}`)).toBe(true);
    const nodeFile = await lstat(
      path.join(fixture.output, process.platform === "win32" ? "node.exe" : "node"),
    );
    expect(nodeFile.isSymbolicLink()).toBe(false);
    const postgresFile = await lstat(
      path.join(
        fixture.output,
        "pg/bin",
        process.platform === "win32" ? "postgres.exe" : "postgres",
      ),
    );
    expect(postgresFile.isFile()).toBe(true);

    const imported = await execFile(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { value, optional } from ${JSON.stringify(pathToFileURL(entry).href)};
       if (value !== "dep" || optional !== true) process.exit(1);`,
    ]);
    expect(imported.stdout).toBe("");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("ships shared chunks and links only real imports of bundled server code", async () => {
  const fixture = await fixtureRepo();
  try {
    await mkdir(path.join(fixture.repo, "apps/api/dist/chunks"), { recursive: true });
    // A chunk the entry reaches through a computed name, and bundled text that only names paths.
    await writeFile(
      path.join(fixture.repo, "apps/api/dist/chunks/shared-1.js"),
      [
        'import { value } from "../../../../node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js";',
        'var init = { "../../node_modules/.pnpm/missing@1.0.0/node_modules/missing/index.js"() {} };',
        'export const text = \x27import "./types.d.ts"\x27;',
        "export { value, init };",
        "",
      ].join("\n"),
    );
    await assembleNativeBundle(request(fixture));
    const chunk = path.join(fixture.output, "apps/api/dist/chunks/shared-1.js");
    const source = await readFile(chunk, "utf8");
    expect(source).toContain("missing@1.0.0");
    await expect(
      lstat(path.join(fixture.output, "node_modules/.pnpm/missing@1.0.0")),
    ).rejects.toThrow();
    const imported = await execFile(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { value } from ${JSON.stringify(pathToFileURL(chunk).href)};
       if (value !== "dep") process.exit(1);`,
    ]);
    expect(imported.stdout).toBe("");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux").each(["usr", ""])(
  "keeps distribution timezone and extension paths relative to the real PostgreSQL binary under '%s'",
  async (directory) => {
    const fixture = await fixtureRepo();
    try {
      const layout = {
        bin: path.join(directory, "lib/postgresql/18/bin"),
        lib: path.join(directory, "lib/postgresql/18/lib"),
        share: path.join(directory, "share/postgresql/18"),
      };
      for (const source of Object.keys(layout)) {
        await rename(
          path.join(fixture.postgres, source),
          path.join(fixture.postgres, `${source}.source`),
        );
      }
      for (const [source, target] of Object.entries(layout)) {
        const destination = path.join(fixture.postgres, target);
        await mkdir(path.dirname(destination), { recursive: true });
        await rename(path.join(fixture.postgres, `${source}.source`), destination);
      }
      await mkdir(path.join(fixture.postgres, layout.share, "timezonesets"));
      await writeFile(path.join(fixture.postgres, layout.share, "timezonesets/Default"), "zones");
      await mkdir(path.join(fixture.postgres, layout.share, "extension"));
      await writeFile(
        path.join(fixture.postgres, layout.share, "extension/probe.control"),
        "extension",
      );
      await assembleNativeBundle(request(fixture));
      const binary = await realpath(path.join(fixture.output, "pg/bin/postgres"));
      const prefix = path.resolve(path.dirname(binary), "../../../..");
      expect(
        await readFile(path.join(prefix, "share/postgresql/18/timezonesets/Default"), "utf8"),
      ).toBe("zones");
      expect(
        await readFile(path.join(prefix, "share/postgresql/18/extension/probe.control"), "utf8"),
      ).toBe("extension");
      expect(await readFile(path.resolve(path.dirname(binary), "../lib/libpq.so"), "utf8")).toBe(
        "lib",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

it("refuses a dependency symlink that leaves the repository and writes no manifest", async () => {
  const fixture = await fixtureRepo();
  try {
    const outside = path.join(fixture.root, "secret.txt");
    await writeFile(outside, "secret");
    await symlink(
      outside,
      path.join(fixture.repo, "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/secret.txt"),
    );
    await expect(assembleNativeBundle(request(fixture))).rejects.toThrow(
      "Native bundle symlink escapes the bundle.",
    );
    expect(await readFile(outside, "utf8")).toBe("secret");
    await expect(lstat(path.join(fixture.output, "manifest.json"))).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("builds a universal bundle only for macOS", async () => {
  await expect(
    assembleNativeBundle({
      platform: "linux",
      arch: "universal",
      nodeBinary: "/node",
      postgresPrefix: "/pg",
      output: "/out",
      repoRoot: "/repo",
    }),
  ).rejects.toThrow("Unsupported native bundle target.");
});

it("vendors MSVC runtime DLLs case-insensitively into pg/bin and pg/lib for Windows bundles", async () => {
  const winManifest = nativeBundleManifest({ platform: "win32", arch: "x64" });
  expect(winManifest.files["pg/bin/vcruntime140.dll"]).toBe(true);
  expect(winManifest.files["pg/bin/vcruntime140_1.dll"]).toBe(true);
  expect(winManifest.files["pg/bin/msvcp140.dll"]).toBe(true);

  const parent = path.resolve(import.meta.dirname, "../../build/native-bundle-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "win-dll-"));
  try {
    const bin = path.join(root, "pg/bin");
    const lib = path.join(root, "pg/lib");
    const system32 = path.join(root, "System32");
    await mkdir(system32, { recursive: true });
    await writeFile(path.join(system32, "VCRUNTIME140.dll"), "vc140");
    await writeFile(path.join(system32, "vcruntime140_1.dll"), "vc140_1");
    await expect(vendorWindowsRuntimeDlls(bin, lib, [system32])).rejects.toThrow(
      "Missing Windows runtime DLL: msvcp140.dll",
    );

    await writeFile(path.join(system32, "MSVCP140.DLL"), "msvcp140");
    await vendorWindowsRuntimeDlls(bin, lib, [system32]);
    for (const dir of [bin, lib]) {
      expect(await readFile(path.join(dir, "vcruntime140.dll"), "utf8")).toBe("vc140");
      expect(await readFile(path.join(dir, "vcruntime140_1.dll"), "utf8")).toBe("vc140_1");
      expect(await readFile(path.join(dir, "msvcp140.dll"), "utf8")).toBe("msvcp140");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
