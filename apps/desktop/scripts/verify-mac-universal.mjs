import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("Requires macOS tools and a packaged app");
const app = path.resolve(process.argv[2]);
const resources = path.join(app, "Contents/Resources");
const inventory = [];
// otool interprets a trailing (GPU) in Electron helper names as archive(member).
// Inspect the identical open file through an inherited descriptor, not that syntax.
function inspectLibraries(flag, file) {
  const fd = openSync(file, "r");
  try {
    return execFileSync("otool", [flag, "/dev/fd/3"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", fd],
    });
  } finally {
    closeSync(fd);
  }
}
async function walk(root) {
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      const target = path.relative(app, await realpath(file));
      if (target === ".." || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) {
        throw new Error(`Symlink escapes application: ${path.relative(app, file)}`);
      }
      await access(file);
      continue;
    }
    if (info.isDirectory()) {
      await walk(file);
      continue;
    }
    const kind = execFileSync("file", ["-b", file], { encoding: "utf8" });
    if (/ELF|PE32|MS-DOS executable/.test(kind)) {
      throw new Error(`Foreign operating-system binary: ${path.relative(app, file)}`);
    }
    if (!kind.includes("Mach-O")) {
      if (file.endsWith(".node") || file.endsWith(".dylib"))
        throw new Error(`Non-Mach-O native binary: ${path.relative(app, file)}`);
      continue;
    }
    const relative = path.relative(app, file);
    const arches = execFileSync("lipo", ["-archs", file], { encoding: "utf8" }).trim().split(/\s+/);
    // Thin files are allowed only in explicit architecture-selected package paths.
    const selected = /(?:darwin[-_]|binding-darwin-)(x64|arm64)(?:[/._-]|$)/.exec(relative)?.[1];
    const required = selected ? [selected === "x64" ? "x86_64" : "arm64"] : ["x86_64", "arm64"];
    if (!required.every((arch) => arches.includes(arch)))
      throw new Error(`Wrong slices: ${relative}: ${arches}`);
    const linked = inspectLibraries("-L", file)
      .split("\n")
      .filter((line) => line.startsWith("\t"))
      .map((line) => line.trim().replace(/ \(compatibility version.*$/, ""));
    const ids = new Set(
      kind.includes("shared library")
        ? inspectLibraries("-D", file)
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => !line.endsWith(":"))
        : [],
    );
    const dependencies = linked.filter((dependency) => !ids.has(dependency));
    for (const dependency of dependencies) {
      if (
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/") ||
        dependency.startsWith("@loader_path/") ||
        dependency.startsWith("@executable_path/") ||
        dependency.startsWith("@rpath/")
      )
        continue;
      throw new Error(`Unbundled dependency in ${relative}: ${path.basename(dependency)}`);
    }
    inventory.push({ file: relative, arches, dependencies });
  }
}
await walk(app);
for (const arch of ["x64", "arm64"]) {
  for (const executable of ["initdb", "pg_ctl", "postgres"]) {
    await access(path.join(resources, "postgres", `darwin-${arch}`, "native/bin", executable));
  }
}
for (const file of [
  "server/api/dist/index.js",
  "server/worker/dist/index.js",
  "server/db/dist/database-access.js",
  "web/index.html",
])
  await access(path.join(resources, file));
if (!(await readdir(path.join(resources, "migrations"))).length)
  throw new Error("Missing migrations");
console.log(JSON.stringify({ kind: "static-universal-inventory", binaries: inventory }, null, 2));
