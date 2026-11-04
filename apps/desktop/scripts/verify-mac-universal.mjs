import { execFileSync } from "node:child_process";
import { access, lstat, readdir } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("Requires macOS tools and a packaged app");
const app = path.resolve(process.argv[2]);
const resources = path.join(app, "Contents/Resources");
const inventory = [];
async function walk(root) {
  for (const name of await readdir(root)) {
    const file = path.join(root, name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      await access(file);
      continue;
    }
    if (info.isDirectory()) {
      await walk(file);
      continue;
    }
    const kind = execFileSync("file", ["-b", file], { encoding: "utf8" });
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
    inventory.push({ file: relative, arches });
  }
}
await walk(app);
for (const arch of ["x64", "arm64"]) {
  for (const executable of ["initdb", "pg_ctl", "postgres"]) {
    await access(
      path.join(
        resources,
        "app.asar.unpacked/node_modules/@embedded-postgres",
        `darwin-${arch}`,
        "native/bin",
        executable,
      ),
    );
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
