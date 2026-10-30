import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const approvedPath = resolve(root, "scripts/icons/approved-icons.json");
const approved = JSON.parse(readFileSync(approvedPath, "utf8"));
const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
const failures = [];
const digest = (path) =>
  createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex");
for (const file of files) {
  if (Object.hasOwn(approved, file) && existsSync(resolve(root, file))) {
    const actual = digest(file);
    if (actual !== approved[file]) failures.push(`${file}: sha256 ${actual} is not approved`);
  }
}
const prefixes = ["99c3a0e9d34a", "dfa002d2990a", "1e03f1fba25a", "6f9d10a24bf6"];
for (const file of files) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
  const actual = digest(file);
  if (prefixes.some((prefix) => actual.startsWith(prefix)))
    failures.push(`${file}: banned orange-blob sha256 ${actual}`);
}
if (failures.length) {
  console.error(["icon check failed:", ...failures].join("\n"));
  process.exit(1);
}
console.log(
  `icon check passed (${Object.keys(approved).length - 1} approved files; ${files.length} tracked files scanned)`,
);
