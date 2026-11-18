import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  isNativePostgresVersion,
  nativeBundleFiles,
  nativeBundleManifest,
  WINDOWS_LINKS_FILE,
  WINDOWS_MSVC_RUNTIME_DLLS,
} from "./native-bundle-contract.mjs";

const PLATFORMS = new Set(["darwin", "linux", "win32"]);
const ARCHES = new Set(["x64", "arm64", "ia32", "arm", "universal"]);
const SERVER_DIST = ["apps/api/dist", "apps/worker/dist"];
// The loader owns these. Copying them onto LD_LIBRARY_PATH makes Node load the wrong libc.
const LOADER_LIBRARIES = new Set([
  "linux-vdso.so.1",
  "libc.so.6",
  "libm.so.6",
  "libdl.so.2",
  "libpthread.so.0",
  "librt.so.1",
  "libresolv.so.2",
  "ld-linux-x86-64.so.2",
  "ld-linux-aarch64.so.1",
  "ld-linux-armhf.so.3",
]);

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function nativeBuildDefaults() {
  return {
    platform: process.platform,
    arch: process.arch,
    output: path.join(desktopDir, "build", "native"),
    repoRoot: path.resolve(desktopDir, "../.."),
  };
}

export function parseNativeBuildArgs(argv, defaults = nativeBuildDefaults()) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || flag === "--") {
      throw new Error(`Unsupported native bundle input: ${flag ?? ""}`);
    }
    const name = flag.slice(2);
    if (Object.hasOwn(values, name)) throw new Error(`Unsupported native bundle input: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing native bundle input: ${flag}`);
    }
    values[name] = value;
    index += 1;
  }
  const allowed = new Set(["platform", "arch", "node", "postgres", "out", "repo"]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) throw new Error(`Unsupported native bundle input: --${name}`);
  }
  return validateRequest({
    platform: values.platform ?? defaults.platform,
    arch: values.arch ?? defaults.arch,
    nodeBinary: values.node,
    postgresPrefix: values.postgres,
    output: values.out ?? defaults.output,
    repoRoot: values.repo ?? defaults.repoRoot,
  });
}

function validateRequest(input) {
  if (!PLATFORMS.has(input.platform) || !ARCHES.has(input.arch)) {
    throw new Error("Unsupported native bundle target.");
  }
  // One macOS bundle serves Intel and Apple silicon; every executable in it must carry both.
  if (input.arch === "universal" && input.platform !== "darwin") {
    throw new Error("Unsupported native bundle target.");
  }
  for (const [flag, value] of [
    ["--node", input.nodeBinary],
    ["--postgres", input.postgresPrefix],
    ["--out", input.output],
    ["--repo", input.repoRoot],
  ]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing native bundle input: ${flag}`);
    }
  }
  return {
    platform: input.platform,
    arch: input.arch,
    nodeBinary: path.resolve(input.nodeBinary),
    postgresPrefix: path.resolve(input.postgresPrefix),
    output: path.resolve(input.output),
    repoRoot: path.resolve(input.repoRoot),
  };
}

export async function assembleNativeBundle(input) {
  const request = validateRequest(input);
  windowsLinks = [];
  if (
    request.platform !== process.platform ||
    (request.arch !== process.arch && request.arch !== "universal")
  ) {
    throw new Error("Native bundle must be assembled on its target platform and architecture.");
  }
  const staging = `${request.output}.staging`;
  if (
    inside(request.output, request.repoRoot) ||
    inside(request.output, request.nodeBinary) ||
    inside(request.output, request.postgresPrefix) ||
    inside(request.postgresPrefix, request.output)
  ) {
    throw new Error("Native bundle output overlaps its sources.");
  }
  if ((await exists(staging)) || (await exists(`${request.output}.previous`))) {
    throw new Error("Existing native build scratch requires inspection.");
  }
  if (await exists(request.output)) {
    const manifest = path.join(request.output, "manifest.json");
    if (!(await exists(manifest))) throw new Error("Existing native output requires inspection.");
    const saved = JSON.parse(await readFile(manifest, "utf8"));
    if (
      saved.version !== 1 ||
      saved.platform !== request.platform ||
      saved.arch !== request.arch ||
      saved.postgresMajor !== 18
    ) {
      throw new Error("Existing native output requires inspection.");
    }
  }
  await mkdir(path.dirname(staging), { recursive: true });
  await mkdir(staging);
  try {
    const server = await scanServer(request.repoRoot, request.platform);
    const databaseIds = await databasePackageIds(request.repoRoot);
    for (const id of databaseIds.values()) server.ids.add(id);
    const closure = await pnpmClosure(request.repoRoot, server.ids);
    for (const id of closure) await copyPnpmPackage(request.repoRoot, staging, id, closure);
    await bundlePrismaCli(request.repoRoot, staging, closure);
    await writeServer(request.repoRoot, staging, server.files);
    await copyWebAndDatabase(request.repoRoot, staging);
    await linkDatabasePackages(staging, databaseIds);
    await stageNode(request, staging);
    await stagePostgres(request, staging);
    await confineSymlinks(staging);
    if (request.arch === "universal") await assertUniversalExecutables(staging);
    await probeBundle(request, staging);
    if (request.platform === "win32") {
      await recordWindowsLinks(staging);
      await assertWindowsPathLengths(staging);
    }
    const manifest = nativeBundleManifest({
      platform: request.platform,
      arch: request.arch,
    });
    await assertManifestFiles(staging, manifest.files);
    const finalManifest = path.join(staging, "manifest.json");
    const partial = `${finalManifest}.partial`;
    await writeFile(partial, `${JSON.stringify(manifest)}\n`);
    await rename(partial, finalManifest);
    await publishStaging(staging, request.output);
    return request.output;
  } catch (error) {
    await removeTree(staging);
    throw error;
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function removeTree(root) {
  if (!(await exists(root))) return;
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(root);
    return;
  }
  for (const name of await readdir(root)) await removeTree(path.join(root, name));
  await rmdir(root);
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

function pnpmId(specifier) {
  return specifier.match(/node_modules\/\.pnpm\/([^/]+)\//)?.[1] ?? null;
}

// An import of a store package: `from`, `import` or `require` and a quoted path. Bundled code
// also quotes store paths as module names, which are not imports.
const STORE_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)(["'])(\.[^"'\n]*node_modules\/[^"'\n]+)\2/g;

function importSpecifiers(source) {
  return [...source.matchAll(STORE_IMPORT)].map((match) => match[3]);
}

async function scanServer(repoRoot, platform) {
  const files = [];
  const ids = new Set();
  // Everything the server build wrote ships: entries and the chunks they share.
  const pending = [
    ...nativeBundleFiles(platform)
      .filter((file) => file.endsWith(".js"))
      .map((file) => path.join(repoRoot, file)),
    ...(
      await Promise.all(SERVER_DIST.map((dist) => javascriptFiles(path.join(repoRoot, dist))))
    ).flat(),
  ];
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    // Bundle entries are forward-slash paths on every platform, including Windows.
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    if (!(await exists(file))) throw new Error(`Missing native bundle source: ${relative}`);
    const real = await realpath(file);
    if (!inside(repoRoot, real)) throw new Error(`Missing native bundle source: ${relative}`);
    seen.add(file);
    files.push(relative);
    const source = await readFile(real, "utf8");
    for (const specifier of importSpecifiers(source)) {
      const id = pnpmId(specifier);
      if (!id) throw new Error("Unsupported native bundle import.");
      const rest = specifier.slice(
        specifier.indexOf("node_modules/.pnpm/") + "node_modules/.pnpm/".length,
      );
      const local = path.join(repoRoot, "node_modules", ".pnpm", rest);
      if (!(await exists(local))) throw new Error(`Missing native bundle dependency: ${id}`);
      ids.add(id);
    }
  }
  for (const file of nativeBundleFiles(platform).filter((entry) => entry.endsWith(".js"))) {
    if (!files.includes(file)) throw new Error(`Missing native bundle source: ${file}`);
  }
  return { files, ids };
}

async function javascriptFiles(directory) {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function databasePackageIds(repoRoot) {
  const manifestPath = path.join(repoRoot, "packages/db/package.json");
  if (!(await exists(manifestPath))) {
    throw new Error("Missing native bundle source: packages/db/package.json");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const names = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
  const ids = new Map();
  const pnpmRoot = path.join(repoRoot, "node_modules", ".pnpm");
  for (const name of names) {
    if (name.startsWith("@rakazo/")) continue;
    const link = path.join(repoRoot, "packages/db/node_modules", name);
    if (!(await exists(link))) {
      throw new Error(`Missing native bundle source: packages/db/node_modules/${name}`);
    }
    const real = await realpath(link);
    const relative = path.relative(pnpmRoot, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const id = relative.split(path.sep)[0];
    if (!id) throw new Error(`Missing native bundle dependency: ${name}`);
    ids.set(name, id);
  }
  return ids;
}

/** The migration CLI, which the bundle carries as one file; see bundlePrismaCli. */
const PRISMA_CLI = /^prisma@/;
/** What the bundled migration CLI still loads from disk: its engines, and the config loader. */
const PRISMA_CLI_RUNTIME = ["@prisma/engines", "jiti"];

async function pnpmClosure(repoRoot, ids, { trimPrismaCli = true } = {}) {
  const pnpmRoot = path.join(repoRoot, "node_modules", ".pnpm");
  const seen = new Set();
  const pending = [...ids.values()];
  if (trimPrismaCli) {
    for (const id of ids.values()) {
      if (!PRISMA_CLI.test(id)) continue;
      // The CLI reaches the config loader through packages it now carries inside itself.
      const full = await pnpmClosure(repoRoot, [id], { trimPrismaCli: false });
      for (const name of PRISMA_CLI_RUNTIME) {
        const found = [...full].filter((other) => other.startsWith(`${name.replace("/", "+")}@`));
        if (found.length !== 1) throw new Error(`Missing native bundle dependency: ${name}`);
        pending.push(found[0]);
      }
    }
  }
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    const directory = path.join(pnpmRoot, id);
    if (!(await exists(directory))) throw new Error(`Missing native bundle dependency: ${id}`);
    seen.add(id);
    const modules = path.join(directory, "node_modules");
    if (!(await exists(modules))) continue;
    for (const link of await dependencyLinks(modules)) {
      if (trimPrismaCli && PRISMA_CLI.test(id)) continue;
      // Windows links read back with backslashes, and junctions as absolute paths.
      const target = path.resolve(path.dirname(link), await readlink(link));
      const [dependency, nested] = path.relative(pnpmRoot, target).split(path.sep);
      if (!dependency || dependency === ".." || nested !== "node_modules")
        throw new Error(`Unsupported native bundle import: ${target}`);
      pending.push(dependency);
    }
  }
  return seen;
}

async function dependencyLinks(directory) {
  const links = [];
  for (const name of await readdir(directory)) {
    const candidate = path.join(directory, name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) links.push(candidate);
    else if (info.isDirectory() && name.startsWith("@")) {
      for (const child of await readdir(candidate)) {
        const nested = path.join(candidate, child);
        if ((await lstat(nested)).isSymbolicLink()) links.push(nested);
      }
    }
  }
  return links;
}

/** Studio and the local dev server, which the migration CLI loads but desktop never runs. */
const PRISMA_CLI_UNUSED = ["@prisma/dev", "@prisma/studio-core"];

function resolvesFrom(directory, specifier) {
  try {
    createRequire(path.join(directory, "package.json")).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

function packageMatches(specifier, names) {
  return names.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
 * Replaces the migration CLI, and the config module the schema config imports, with single files
 * holding their dependencies, so the bundle skips the thousands of files those span. The CLI
 * finds its wasm next to itself, which stays true in place.
 */
async function bundlePrismaCli(repoRoot, staging, closure) {
  const ids = [...closure];
  const cli = ids.find((id) => PRISMA_CLI.test(id));
  if (!cli) return;
  const pnpmRoot = path.join(repoRoot, "node_modules", ".pnpm");
  const source = path.join(pnpmRoot, cli, "node_modules/prisma");
  const target = path.join(staging, PNPM_DIR, storeName(cli), "node_modules/prisma");
  const builtins = new Set(builtinModules);
  for (const file of ["build/index.js", "config.js"]) {
    const result = await build({
      entryPoints: [path.join(source, file)],
      outfile: path.join(target, file),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      conditions: ["node", "require"],
      mainFields: ["main", "module"],
      logLevel: "error",
      allowOverwrite: true,
      metafile: true,
      define: { "import.meta.url": "__vnbotImportMetaUrl" },
      banner: {
        js: 'const __vnbotImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
      },
      plugins: [
        {
          name: "prisma-cli",
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, (args) => {
              if (packageMatches(args.path, PRISMA_CLI_UNUSED))
                return { path: args.path, namespace: "unused" };
              if (args.path.startsWith("node:") || builtins.has(args.path.split("/")[0]))
                return { path: args.path, external: true };
              if (packageMatches(args.path, PRISMA_CLI_RUNTIME))
                return { path: args.path, external: true };
              return undefined;
            });
            builder.onLoad({ filter: /.*/, namespace: "unused" }, () => ({
              contents: "module.exports = {};",
              loader: "js",
            }));
          },
        },
      ],
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const { path: imported, external } of output.imports) {
        // A relative path stays inside the CLI package, which ships whole.
        if (
          !external ||
          imported.startsWith(".") ||
          imported.startsWith("node:") ||
          builtins.has(imported.split("/")[0])
        )
          continue;
        if (packageMatches(imported, PRISMA_CLI_RUNTIME)) continue;
        // An optional driver the CLI tries in a try block was never installed, here or before.
        if (!resolvesFrom(source, imported)) continue;
        throw new Error(`Unsupported native bundle import: ${imported}`);
      }
    }
  }
  // The config loader was a dependency of a dependency; the CLI now asks for it by name.
  const loader = ids.find((id) => id.startsWith("jiti@"));
  if (!loader) throw new Error("Missing native bundle dependency: jiti");
  const link = path.join(staging, PNPM_DIR, storeName(cli), "node_modules/jiti");
  const linked = path.join(staging, PNPM_DIR, storeName(loader), "node_modules/jiti");
  if (process.platform === "win32") {
    await symlink(linked, link, "junction");
    windowsLinks.push({ link, target: linked });
  } else {
    await symlink(path.relative(path.dirname(link), linked), link);
  }
}

async function copyPnpmPackage(repoRoot, staging, id, closure) {
  const source = path.join(repoRoot, "node_modules", ".pnpm", id);
  const destination = path.join(staging, "node_modules", ".pnpm", storeName(id));
  const pnpmRoot = path.join(repoRoot, "node_modules", ".pnpm");
  await copyPreservingStoreLinks(source, destination, pnpmRoot, closure);
}

const PNPM_DIR = path.join("node_modules", ".pnpm");

/**
 * The Windows installer skips files whose path passes 260 characters, so a Windows bundle names
 * each store package by a short hash instead of its long pnpm folder name.
 */
function storeName(id) {
  if (process.platform !== "win32") return id;
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

/** A path inside the store, with its first folder renamed by `storeName`. */
function storePath(relative) {
  const [id = "", ...rest] = relative.split(/[\\/]/);
  return path.join(storeName(id), ...rest);
}

/**
 * The longest bundle path that still installs: Windows paths stop at 259 characters, and the
 * bundle sits under C:\Users\<name up to 20>\AppData\Local\Programs\vnbot\resources\native\.
 */
export const WINDOWS_PATH_BUDGET =
  259 - "C:\\Users\\".length - 20 - "\\AppData\\Local\\Programs\\vnbot\\resources\\native\\".length;

async function assertWindowsPathLengths(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(root, candidate);
      if (relative.length > WINDOWS_PATH_BUDGET) {
        throw new Error(
          `Native bundle path too long for Windows (${relative.length}): ${relative}`,
        );
      }
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
}
/** Junctions made while staging a Windows bundle; removed before packaging. */
let windowsLinks = [];

/** Replaces the staging junctions with a list the app turns back into junctions. */
async function recordWindowsLinks(staging) {
  const links = windowsLinks.map(({ link, target }) => ({
    link: path.relative(staging, link).split(path.sep).join("/"),
    target: path.relative(staging, target).split(path.sep).join("/"),
  }));
  for (const { link } of windowsLinks) await rmdir(link);
  windowsLinks = [];
  await writeFile(path.join(staging, WINDOWS_LINKS_FILE), `${JSON.stringify(links)}\n`);
}

async function copyPreservingStoreLinks(source, destination, pnpmRoot, closure) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(from);
      const resolved = path.resolve(path.dirname(from), target);
      if (inside(pnpmRoot, resolved)) {
        // A dependency the bundle leaves out, such as one the migration CLI carries inside itself.
        if (closure && !closure.has(path.relative(pnpmRoot, resolved).split(path.sep)[0])) continue;
        // Windows installers carry no links. A junction serves the probe below, then is
        // listed in windows-links.json and recreated by the app on first start.
        if (process.platform === "win32") {
          const staged = path.join(
            destination.slice(0, destination.indexOf(PNPM_DIR) + PNPM_DIR.length),
            storePath(path.relative(pnpmRoot, resolved)),
          );
          await symlink(staged, to, "junction");
          windowsLinks.push({ link: to, target: staged });
        } else {
          await symlink(target, to);
        }
        continue;
      }
      const real = await realpath(from);
      if (!inside(path.resolve(pnpmRoot, "../.."), real)) {
        throw new Error("Native bundle symlink escapes the bundle.");
      }
      await cp(real, to, { recursive: true, dereference: true });
      continue;
    }
    if (entry.isDirectory()) await copyPreservingStoreLinks(from, to, pnpmRoot, closure);
    else if (entry.isFile() && !(process.platform === "win32" && BUILD_ONLY_FILE.test(entry.name)))
      await cp(from, to);
  }
}

/** Type declarations and source maps nothing reads at run time; Windows paths have no room. */
const BUILD_ONLY_FILE = /\.(d\.[cm]?ts|map)$/;

async function writeServer(repoRoot, staging, files) {
  for (const file of files) {
    const source = path.join(repoRoot, file);
    const destination = path.join(staging, file);
    await mkdir(path.dirname(destination), { recursive: true });
    const original = await readFile(source, "utf8");
    const replacements = new Map();
    for (const match of original.matchAll(STORE_IMPORT)) {
      const specifier = match[3];
      if (specifier === undefined || replacements.has(specifier)) continue;
      const id = pnpmId(specifier);
      if (!id) throw new Error("Unsupported native bundle import.");
      const rest = specifier.slice(
        specifier.indexOf("node_modules/.pnpm/") + "node_modules/.pnpm/".length,
      );
      const target = path.join(staging, "node_modules", ".pnpm", storePath(rest));
      if (!(await exists(target))) throw new Error(`Missing native bundle dependency: ${id}`);
      replacements.set(specifier, relativeSpecifier(destination, target));
    }
    const rewritten = original.replace(STORE_IMPORT, (_full, keyword, quote, specifier) => {
      const next = replacements.get(specifier);
      if (next === undefined) throw new Error("Unsupported native bundle import.");
      return `${keyword}${quote}${next}${quote}`;
    });
    await writeFile(destination, rewritten);
  }
  for (const file of ["apps/api/package.json", "apps/worker/package.json"]) {
    await copyRepoFile(repoRoot, staging, file);
  }
}

function relativeSpecifier(fromFile, target) {
  let relative = path.relative(path.dirname(fromFile), target);
  if (!relative.startsWith(".")) relative = `.${path.sep}${relative}`;
  return relative.split(path.sep).join("/");
}

async function copyWebAndDatabase(repoRoot, staging) {
  await copyDereferenced(
    path.join(repoRoot, "apps/web/dist"),
    path.join(staging, "apps/web/dist"),
    repoRoot,
  );
  await copyRepoFile(repoRoot, staging, "packages/db/package.json");
  await copyRepoFile(repoRoot, staging, "packages/db/prisma/schema.prisma");
  await copyRepoFile(repoRoot, staging, "packages/db/prisma.config.ts");
  const migrations = path.join(repoRoot, "packages/db/prisma/migrations");
  if (!(await exists(migrations))) {
    throw new Error("Missing native bundle source: packages/db/prisma/migrations");
  }
  await copyDereferenced(migrations, path.join(staging, "packages/db/prisma/migrations"), repoRoot);
  if (!(await findNamed(path.join(staging, "packages/db/prisma/migrations"), "migration.sql"))) {
    throw new Error("Missing native bundle source: packages/db/prisma/migrations");
  }
}

async function findNamed(directory, name) {
  if (!(await exists(directory))) return false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await findNamed(candidate, name)) return true;
    } else if (entry.name === name) return true;
  }
  return false;
}

async function copyRepoFile(repoRoot, staging, file) {
  const source = path.join(repoRoot, file);
  if (!(await exists(source))) throw new Error(`Missing native bundle source: ${file}`);
  const real = await realpath(source);
  if (!inside(repoRoot, real)) throw new Error(`Missing native bundle source: ${file}`);
  const destination = path.join(staging, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(real, destination);
}

async function copyDereferenced(source, destination, allowedRoot) {
  if (!(await exists(source))) {
    throw new Error(`Missing native bundle source: ${path.relative(allowedRoot, source)}`);
  }
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.endsWith(".map")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await realpath(from);
      if (!inside(allowedRoot, real)) throw new Error("Native bundle symlink escapes the bundle.");
      const info = await stat(real);
      if (info.isDirectory()) await copyDereferenced(real, to, allowedRoot);
      else await cp(real, to);
      continue;
    }
    if (entry.isDirectory()) await copyDereferenced(from, to, allowedRoot);
    else if (entry.isFile()) await cp(from, to);
  }
}

async function linkDatabasePackages(staging, ids) {
  for (const [name, id] of ids) {
    const destination = path.join(staging, "packages/db/node_modules", name);
    const target = path.join(staging, "node_modules", ".pnpm", storeName(id), "node_modules", name);
    if (!(await exists(target))) throw new Error(`Missing native bundle dependency: ${id}`);
    await mkdir(path.dirname(destination), { recursive: true });
    if (process.platform === "win32") {
      // Packaging copies a link's contents, where Prisma could not reach its own dependencies.
      await symlink(target, destination, "junction");
      windowsLinks.push({ link: destination, target });
    } else {
      await symlink(path.relative(path.dirname(destination), target), destination);
    }
  }
}

async function stageNode(request, staging) {
  const name = request.platform === "win32" ? "node.exe" : "node";
  if (!(await exists(request.nodeBinary))) throw new Error("Missing native bundle source: node");
  const destination = path.join(staging, name);
  await cp(request.nodeBinary, destination, { dereference: true });
  await chmod(destination, 0o755);
}

async function stagePostgres(request, staging) {
  const layout = await locatePostgres(request.postgresPrefix, request.platform);
  const relocated =
    request.platform === "linux" && layout.bin !== path.join(request.postgresPrefix, "bin");
  const binaryDirectory = relocated
    ? path.join(staging, path.relative(request.postgresPrefix, layout.bin))
    : path.join(staging, "pg/bin");
  await mkdir(binaryDirectory, { recursive: true });
  for (const file of nativeBundleFiles(request.platform)) {
    if (!file.startsWith("pg/bin/") || file.toLowerCase().endsWith(".dll")) continue;
    const source = path.join(layout.bin, path.basename(file));
    if (!(await exists(source))) throw new Error(`Missing native bundle source: ${file}`);
    const destination = path.join(binaryDirectory, path.basename(file));
    await cp(source, destination, { dereference: true });
    await chmod(destination, 0o755);
    if (relocated) {
      const entry = path.join(staging, file);
      await mkdir(path.dirname(entry), { recursive: true });
      await symlink(path.relative(path.dirname(entry), destination), entry);
    }
  }
  if (request.platform === "win32") {
    // Windows loads the server's DLLs from beside the executable.
    for (const name of await readdir(layout.bin)) {
      if (name.toLowerCase().endsWith(".dll")) {
        await cp(path.join(layout.bin, name), path.join(binaryDirectory, name), {
          dereference: true,
        });
      }
    }
  }
  await copyDereferenced(layout.lib, path.join(staging, "pg/lib"), request.postgresPrefix);
  await copyDereferenced(layout.share, path.join(staging, "pg/share"), request.postgresPrefix);
  if (request.platform === "win32") {
    await vendorWindowsRuntimeDlls(
      binaryDirectory,
      path.join(staging, "pg/lib"),
      windowsRuntimeSearchDirs(request.postgresPrefix, layout.bin),
    );
  }
  if (relocated) {
    // PostgreSQL locates timezone and extension files relative to its real executable.
    for (const [source, target] of [
      [layout.lib, "pg/lib"],
      [layout.share, "pg/share"],
    ]) {
      const alias = path.join(staging, path.relative(request.postgresPrefix, source));
      await mkdir(path.dirname(alias), { recursive: true });
      await symlink(path.relative(path.dirname(alias), path.join(staging, target)), alias);
    }
  }
  if (request.platform === "linux") {
    await vendorElfLibraries(
      nativeBundleFiles(request.platform)
        .filter((file) => file.startsWith("pg/bin/"))
        .map((file) => path.join(staging, file)),
      librarySearchDirs(request.postgresPrefix, layout.lib),
      path.join(staging, "pg/lib"),
    );
  }
}

function windowsRuntimeSearchDirs(postgresPrefix, layoutBin) {
  const dirs = [layoutBin, path.join(postgresPrefix, "bin")];
  const vcRedist = process.env.VCToolsRedistDir;
  if (vcRedist) {
    dirs.push(path.join(vcRedist, "x64", "Microsoft.VC143.CRT"));
    dirs.push(path.join(vcRedist, "x64", "Microsoft.VC142.CRT"));
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  dirs.push(path.join(systemRoot, "System32"));
  return dirs;
}

export async function vendorWindowsRuntimeDlls(binaryDirectory, libraryDirectory, searchDirs) {
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(libraryDirectory, { recursive: true });
  const directories = [binaryDirectory, ...searchDirs];
  const listings = new Map();
  for (const directory of directories) {
    if (listings.has(directory) || !(await exists(directory))) continue;
    listings.set(directory, await readdir(directory));
  }
  for (const requiredName of WINDOWS_MSVC_RUNTIME_DLLS) {
    const targetLower = requiredName.toLowerCase();
    let source = null;
    for (const [directory, names] of listings) {
      const match = names.find((entry) => entry.toLowerCase() === targetLower);
      if (match) {
        source = path.join(directory, match);
        break;
      }
    }
    if (!source) throw new Error(`Missing Windows runtime DLL: ${requiredName}`);
    const inBin = path.join(binaryDirectory, requiredName);
    if (path.resolve(source) !== path.resolve(inBin)) {
      await cp(source, inBin, { dereference: true });
    }
    const inLib = path.join(libraryDirectory, requiredName);
    if (path.resolve(source) !== path.resolve(inLib)) {
      await cp(source, inLib, { dereference: true });
    }
  }
}

async function locatePostgres(prefix, platform) {
  const exe = platform === "win32" ? "postgres.exe" : "postgres";
  const layouts = [
    {
      bin: path.join(prefix, "bin"),
      lib: path.join(prefix, "lib"),
      share: path.join(prefix, "share"),
    },
    {
      bin: path.join(prefix, "usr/lib/postgresql/18/bin"),
      lib: path.join(prefix, "usr/lib/postgresql/18/lib"),
      share: path.join(prefix, "usr/share/postgresql/18"),
    },
    {
      bin: path.join(prefix, "lib/postgresql/18/bin"),
      lib: path.join(prefix, "lib/postgresql/18/lib"),
      share: path.join(prefix, "share/postgresql/18"),
    },
  ];
  for (const layout of layouts) {
    if (
      (await exists(path.join(layout.bin, exe))) &&
      (await exists(layout.lib)) &&
      (await exists(layout.share))
    ) {
      return layout;
    }
  }
  throw new Error("Missing native bundle source: postgres");
}

function librarySearchDirs(prefix, postgresLib) {
  const triples = ["x86_64-linux-gnu", "aarch64-linux-gnu", "arm-linux-gnueabihf"];
  const dirs = [postgresLib];
  for (const root of [prefix, path.join(prefix, "usr"), path.join(prefix, "lib")]) {
    dirs.push(path.join(root, "lib"), path.join(root, "lib64"));
    for (const triple of triples) dirs.push(path.join(root, "lib", triple));
  }
  for (const triple of triples) {
    dirs.push(path.join("/lib", triple), path.join("/usr/lib", triple));
  }
  dirs.push("/lib64", "/usr/lib64", "/lib", "/usr/lib");
  return dirs;
}

async function vendorElfLibraries(binaries, searchDirs, destination) {
  const pending = [...binaries];
  const seen = new Set();
  while (pending.length > 0) {
    const binary = pending.pop();
    if (binary === undefined || seen.has(binary)) continue;
    seen.add(binary);
    const needed = await readElfNeeded(binary);
    if (needed === null) continue;
    for (const soname of needed) {
      if (LOADER_LIBRARIES.has(soname)) continue;
      const installed = path.join(destination, soname);
      if (await exists(installed)) {
        pending.push(await realpath(installed));
        continue;
      }
      const source = await findLibrary(soname, searchDirs);
      if (source === null) throw new Error(`Missing PostgreSQL library: ${soname}`);
      await copySharedObject(source, destination);
      pending.push(await realpath(path.join(destination, soname)));
    }
  }
}

async function findLibrary(soname, searchDirs) {
  for (const directory of searchDirs) {
    const candidate = path.join(directory, soname);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function copySharedObject(source, destinationLib) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const targetName = path.basename(await realpath(source));
    const linked = path.resolve(path.dirname(source), await readlink(source));
    await copySharedObject(linked, destinationLib);
    const alias = path.join(destinationLib, path.basename(source));
    if (!(await exists(alias))) await symlink(targetName, alias);
    return;
  }
  const destination = path.join(destinationLib, path.basename(source));
  if (!(await exists(destination))) await cp(source, destination);
}

async function readElfNeeded(file) {
  const binary = await readFile(file);
  if (
    binary.length < 64 ||
    binary.readUInt32BE(0) !== 0x7f454c46 ||
    binary[4] !== 2 ||
    binary[5] !== 1
  ) {
    return null;
  }
  const programOffset = Number(binary.readBigUInt64LE(32));
  const programSize = binary.readUInt16LE(54);
  const programCount = binary.readUInt16LE(56);
  let dynamicOffset = 0;
  let dynamicSize = 0;
  let foundDynamic = false;
  const loads = [];
  for (let index = 0; index < programCount; index += 1) {
    const offset = programOffset + index * programSize;
    const type = binary.readUInt32LE(offset);
    if (type === 1) {
      loads.push({
        offset: binary.readBigUInt64LE(offset + 8),
        address: binary.readBigUInt64LE(offset + 16),
        size: binary.readBigUInt64LE(offset + 32),
      });
    }
    if (type === 2) {
      dynamicOffset = Number(binary.readBigUInt64LE(offset + 8));
      dynamicSize = Number(binary.readBigUInt64LE(offset + 32));
      foundDynamic = true;
    }
  }
  if (!foundDynamic) return [];
  const addressToOffset = (address) => {
    for (const load of loads) {
      if (address >= load.address && address < load.address + load.size) {
        return Number(load.offset + (address - load.address));
      }
    }
    throw new Error("Invalid native bundle asset.");
  };
  let stringAddress = 0n;
  const entries = [];
  for (let offset = dynamicOffset; offset < dynamicOffset + dynamicSize; offset += 16) {
    const tag = binary.readBigInt64LE(offset);
    const value = binary.readBigUInt64LE(offset + 8);
    if (tag === 0n) break;
    if (tag === 5n) stringAddress = value;
    if (tag === 1n) entries.push(value);
  }
  const stringOffset = addressToOffset(stringAddress);
  return entries.map((value) => {
    let text = "";
    for (let index = stringOffset + Number(value); binary[index] && text.length < 200; index += 1) {
      text += String.fromCharCode(binary[index] ?? 0);
    }
    if (!/^[A-Za-z0-9._+-]+$/.test(text)) throw new Error("Invalid native bundle asset.");
    return text;
  });
}

async function confineSymlinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        let real;
        try {
          real = await realpath(candidate);
        } catch {
          throw new Error("Native bundle symlink escapes the bundle.");
        }
        if (!inside(root, real)) throw new Error("Native bundle symlink escapes the bundle.");
        continue;
      }
      if (entry.isDirectory()) pending.push(candidate);
    }
  }
}

async function probeBundle(request, staging) {
  const lib = path.join(staging, "pg/lib");
  const nodeName = request.platform === "win32" ? "node.exe" : "node";
  const nodeTarget = await runFile(
    path.join(staging, nodeName),
    ["-p", "process.platform + '/' + process.arch"],
    { LD_LIBRARY_PATH: lib, DYLD_LIBRARY_PATH: lib },
    "Native Node target mismatch.",
  );
  // A universal node answers with the chip it runs on, which is the build host.
  const expectedArch = request.arch === "universal" ? process.arch : request.arch;
  if (nodeTarget !== `${request.platform}/${expectedArch}`) {
    throw new Error("Native Node target mismatch.");
  }
  const postgres = nativeBundleFiles(request.platform).find((file) =>
    file.startsWith("pg/bin/postgres"),
  );
  const version = await runFile(
    path.join(staging, postgres ?? "pg/bin/postgres"),
    ["--version"],
    { LD_LIBRARY_PATH: lib, DYLD_LIBRARY_PATH: lib },
    "Native PostgreSQL version mismatch.",
  );
  if (!isNativePostgresVersion(version)) throw new Error("Native PostgreSQL version mismatch.");
}

function runFile(file, args, env, failure) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: { ...process.env, ...env },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(new Error(failure));
        else resolve(stdout.trim());
      },
    );
  });
}

async function assertManifestFiles(root, files) {
  for (const file of Object.keys(files)) {
    const candidate = path.join(root, file);
    let info;
    try {
      info = await stat(candidate);
    } catch {
      throw new Error(`Missing native bundle source: ${file}`);
    }
    if (!info.isFile()) throw new Error(`Missing native bundle source: ${file}`);
    const real = await realpath(candidate);
    if (!inside(root, real)) throw new Error("Native bundle symlink escapes the bundle.");
  }
  for (const directory of ["pg/lib", "pg/share"]) {
    const full = path.join(root, directory);
    const info = await stat(full);
    if (!info.isDirectory() || (await readdir(full)).length === 0) {
      throw new Error(`Missing native bundle source: ${directory}`);
    }
  }
}

async function publishStaging(staging, output) {
  const previous = `${output}.previous`;
  await mkdir(path.dirname(output), { recursive: true });
  if (await exists(previous)) throw new Error("Existing native build scratch requires inspection.");
  if (await exists(output)) await rename(output, previous);
  try {
    await rename(staging, output);
  } catch (error) {
    if ((await exists(previous)) && !(await exists(output))) await rename(previous, output);
    throw error;
  }
  await removeTree(previous);
}

/** Thin Mach-O headers. A thin node, server or library would start on one chip only. */
const THIN_MAGIC = new Set(["cffaedfe", "cefaedfe"]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const output = await assembleNativeBundle(parseNativeBuildArgs(process.argv.slice(2)));
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Native bundle assembly failed."}\n`,
    );
    process.exitCode = 1;
  }
}

/** A universal bundle keeps node and both PostgreSQL trees fat; per-arch npm packages may be thin. */
async function assertUniversalExecutables(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(root, full) !== "node_modules") pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const handle = await open(full, "r");
      const header = Buffer.alloc(4);
      try {
        await handle.read(header, 0, 4, 0);
      } finally {
        await handle.close();
      }
      const magic = header.toString("hex");
      if (THIN_MAGIC.has(magic)) {
        throw new Error(
          `Universal native bundle has a single-architecture file: ${path.relative(root, full)}`,
        );
      }
    }
  }
}
