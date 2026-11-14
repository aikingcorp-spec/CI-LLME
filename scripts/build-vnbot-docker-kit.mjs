import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkDockerSourceDependencies } from "./check-docker-source-dependencies.mjs";

const root = path.resolve(import.meta.dirname, "..");
const [revision, destination] = process.argv.slice(2);
if (!revision || !destination) {
  throw new Error("Usage: node scripts/build-vnbot-docker-kit.mjs COMMIT OUTPUT.zip");
}
const commit = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
  cwd: root,
  encoding: "utf8",
}).trim();
checkDockerSourceDependencies(commit);
const output = path.resolve(destination);
mkdirSync(path.dirname(output), { recursive: true });
const prefix = "VNBot-Docker/";
const virtual = (name, content) => `--add-virtual-file=${prefix}${name}:${content}`;
const cmd = (action) =>
  `@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0VNBot.ps1" -Action ${action}\r\nif errorlevel 1 (\r\n  pause\r\n  exit /b 1\r\n)\r\npause\r\n`;
execFileSync(
  "git",
  [
    "archive",
    "--format=zip",
    `--output=${output}`,
    `--prefix=${prefix}source/`,
    virtual("CHAY-VNBOT.cmd", cmd("Start")),
    virtual("DUNG-VNBOT.cmd", cmd("Stop")),
    virtual("KIEM-TRA.cmd", cmd("Status")),
    virtual("CAU-HINH-MAIL.cmd", cmd("Configure")),
    virtual("SUA-SANDBOX.cmd", cmd("RepairSandbox")),
    virtual("VNBot.ps1", readFileSync(path.join(root, "infra/compose/vnbot-docker.ps1"), "utf8")),
    virtual(
      "DOC-TRUOC.txt",
      readFileSync(path.join(root, "infra/compose/vnbot-docker-guide.txt"), "utf8"),
    ),
    virtual("SOURCE-COMMIT.txt", `${commit}\n`),
    commit,
    "apps",
    "packages",
    "infra",
    "scripts",
    "patches",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".pnpmfile.cjs",
    ".dockerignore",
    ".env.example",
    "tsconfig.base.json",
    "turbo.json",
    "LICENSE",
    "NOTICE",
  ],
  { cwd: root, stdio: "pipe" },
);
const bytes = readFileSync(output);
const digest = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
console.log(
  JSON.stringify({ output, sourceCommit: commit, sizeBytes: bytes.length, sha256: digest }),
);
