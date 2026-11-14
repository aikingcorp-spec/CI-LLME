import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPnpm } from "./pnpm.mjs";

const root = path.resolve(import.meta.dirname, "..");

export function checkDockerSourceDependencies(commit) {
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", commit], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(
      (file) =>
        file === "package.json" ||
        /^(apps|packages)\/[^/]+\/package.json$/.test(file) ||
        /^infra\/(sandboxes\/supervisor|updater)\/package.json$/.test(file) ||
        ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs"].includes(file) ||
        file.startsWith("patches/"),
    );
  mkdirSync(path.join(root, ".tmp"), { recursive: true });
  const directory = mkdtempSync(path.join(root, ".tmp/vnbot-dependencies-"));
  try {
    for (const file of files) {
      const destination = path.join(directory, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, execFileSync("git", ["show", `${commit}:${file}`], { cwd: root }));
    }
    // Validate the exact source revision being shipped, without creating another
    // node_modules tree or changing the active workspace's dependencies.
    runPnpm(
      [
        "install",
        "--lockfile-only",
        "--frozen-lockfile",
        "--offline",
        "--ignore-scripts",
        "--cpu=current",
        "--os=current",
        "--filter=.",
        "--filter=@rakazo/api...",
        "--filter=@rakazo/worker...",
        "--filter=@rakazo/web...",
        "--filter=@rakazo/sandbox-supervisor...",
      ],
      { cwd: directory, stdio: "pipe", timeout: 60_000 },
    );
    return { manifests: files.filter((file) => file.endsWith("package.json")).length };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const revision = process.argv[2];
  if (!revision) throw new Error("Usage: node scripts/check-docker-source-dependencies.mjs COMMIT");
  const commit = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  console.log(JSON.stringify(checkDockerSourceDependencies(commit)));
}
