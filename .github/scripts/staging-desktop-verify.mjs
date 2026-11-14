import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acceptSmokeOutput } from "../../apps/desktop/src/native-smoke.ts";
import {
  assertStagingDistribution,
  readPublicPin,
} from "../../apps/desktop/src/public-distribution.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "../..");

// Labels from the standard GitHub-hosted runner table on 2026-11-14:
// https://docs.github.com/en/actions/reference/runners/github-hosted-runners
export const STAGING_RUNNERS = [
  { runner: "ubuntu-24.04", platform: "linux", arch: "x64", targetFlags: ["--linux", "--x64"] },
  { runner: "windows-2025", platform: "win32", arch: "x64", targetFlags: ["--win", "--x64"] },
  {
    runner: "macos-26-intel",
    platform: "darwin",
    arch: "x64",
    targetFlags: ["--mac", "--x64"],
  },
  { runner: "macos-26", platform: "darwin", arch: "arm64", targetFlags: ["--mac", "--arm64"] },
];

const EXTENSIONS = {
  AppImage: ".AppImage",
  deb: ".deb",
  nsis: ".exe",
  msi: ".msi",
  dmg: ".dmg",
  zip: ".zip",
};

function targetName(target) {
  return typeof target === "string" ? target : target.target;
}

function targetArch(target) {
  return typeof target === "string" ? undefined : target.arch;
}

export function planStagingDesktop(build, runnerLabel) {
  const runner = STAGING_RUNNERS.find((item) => item.runner === runnerLabel);
  if (!runner) throw new Error(`Unsupported staging runner: ${runnerLabel}`);
  const section =
    runner.platform === "linux" ? build.linux : runner.platform === "win32" ? build.win : build.mac;
  const names = (section?.target ?? [])
    .filter((target) => {
      const arch = targetArch(target);
      return arch === undefined || arch === runner.arch;
    })
    .map(targetName);
  const extensions = names.map((name) => {
    const extension = EXTENSIONS[name];
    if (!extension) throw new Error(`Unsupported installer target: ${name}`);
    return extension;
  });
  const args = [...runner.targetFlags, "--publish", "never", "-c.publish=null"];
  if (runner.platform === "darwin") args.push("-c.mac.identity=null", "-c.mac.notarize=false");
  return {
    runner: runner.runner,
    platform: runner.platform,
    arch: runner.arch,
    args,
    extensions,
  };
}

function feedName(name) {
  return name === "app-update.yml" || /^latest.*\.ya?ml$/.test(name);
}

async function collectFeeds(directory, found) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFeeds(full, found);
      continue;
    }
    if (feedName(entry.name)) found.push(full);
  }
}

export async function verifyInstallers({ outDir, extensions, checksumPath }) {
  const feeds = [];
  await collectFeeds(outDir, feeds);
  if (feeds.length > 0) {
    throw new Error(`Update feed files are present: ${feeds.join(", ")}`);
  }
  const names = (await readdir(outDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const chosen = [];
  for (const extension of extensions) {
    const matches = names.filter((name) => name.endsWith(extension));
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${extension} installer in ${outDir}, found ${matches.length}: ${matches.join(", ")}`,
      );
    }
    chosen.push(matches[0]);
  }
  const lines = [];
  for (const name of [...chosen].sort()) {
    const data = await readFile(path.join(outDir, name));
    lines.push(`${createHash("sha256").update(data).digest("hex")}  ${name}`);
  }
  const body = `${lines.join("\n")}\n`;
  await mkdir(path.dirname(checksumPath), { recursive: true });
  await writeFile(checksumPath, body);
  return body;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function executableName(platform) {
  return platform === "win32" ? "postgres.exe" : "postgres";
}

export async function discoverPostgres(root, major, platform = process.platform) {
  const executable = executableName(platform);
  const version = String(major);
  const candidates = [
    {
      kind: "debian",
      binDir: path.join(root, "lib", "postgresql", version, "bin"),
      libDir: path.join(root, "lib", "postgresql", version, "lib"),
      shareDir: path.join(root, "share", "postgresql", version),
    },
    {
      kind: "debian-usr",
      binDir: path.join(root, "usr", "lib", "postgresql", version, "bin"),
      libDir: path.join(root, "usr", "lib", "postgresql", version, "lib"),
      shareDir: path.join(root, "usr", "share", "postgresql", version),
    },
    {
      kind: "flat",
      binDir: path.join(root, "bin"),
      libDir: path.join(root, "lib"),
      shareDir: path.join(root, "share"),
    },
    {
      kind: "nested-share",
      binDir: path.join(root, "bin"),
      libDir: path.join(root, "lib"),
      shareDir: path.join(root, "share", "postgresql"),
    },
  ];
  for (const candidate of candidates) {
    if (
      (await exists(path.join(candidate.binDir, executable))) &&
      (await exists(candidate.libDir)) &&
      (await exists(path.join(candidate.shareDir, "postgres.bki")))
    ) {
      return candidate;
    }
  }
  return null;
}

async function copyTree(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, dereference: true });
}

export async function prepareCurrentPrefix({ root, major, dest, platform = process.platform }) {
  const found = await discoverPostgres(root, major, platform);
  if (!found) throw new Error(`Missing native bundle source: postgres ${major} under ${root}`);
  if (found.kind !== "nested-share") return path.resolve(root);
  await copyTree(found.binDir, path.join(dest, "bin"));
  await copyTree(found.libDir, path.join(dest, "lib"));
  await copyTree(found.shareDir, path.join(dest, "share"));
  return path.resolve(dest);
}

export async function prepareLegacyPrefix({ root, major, dest, platform = process.platform }) {
  const found = await discoverPostgres(root, major, platform);
  if (!found) throw new Error(`Missing native bundle source: postgres ${major} under ${root}`);
  await copyTree(found.binDir, path.join(dest, "bin"));
  await copyTree(found.shareDir, path.join(dest, "share", "postgresql"));
  await copyTree(found.libDir, path.join(dest, "lib", "postgresql"));
  const entries = await readdir(found.libDir, { withFileTypes: true });
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (!entry.isFile() || (!lower.endsWith(".dylib") && !lower.endsWith(".dll"))) continue;
    await cp(path.join(found.libDir, entry.name), path.join(dest, "lib", entry.name), {
      dereference: true,
    });
  }
  return path.resolve(dest);
}

export const SMOKE_TIMEOUT_MS = 180_000;

const SMOKE_STRIPPED_ENV = [
  "RAKAZO_IDENTITY_PIN",
  "RAKAZO_CLOUD_URL",
  "RAKAZO_WEB_URL",
  "RAKAZO_FORCE_SETUP",
  "RAKAZO_LOCAL_WEB_URL",
  "SMTP_URL",
  "EMAIL_FROM",
  "SIGNUP_ALLOWLIST",
  "AUTH_EMAIL_ALLOWLIST",
];

export function smokeProcessEnv(base, profile) {
  const env = { ...base };
  for (const key of SMOKE_STRIPPED_ENV) delete env[key];
  env.RAKAZO_DESKTOP_SMOKE = "1";
  env.RAKAZO_PERFORMANCE_USER_DATA = profile;
  env.ELECTRON_ENABLE_LOGGING = "1";
  return env;
}

export function assertSmokeProfile(profile) {
  const resolved = path.resolve(profile);
  const name = path.basename(resolved);
  if (name !== "vnbot-desktop-smoke" && !name.startsWith("vnbot-desktop-smoke-")) {
    throw new Error("Smoke profile must be a vnbot-desktop-smoke directory.");
  }
  return resolved;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function linuxCommand(installer) {
  return {
    command: "xvfb-run",
    args: [
      "-a",
      "-s",
      "-screen 0 1280x800x24",
      installer,
      "--appimage-extract-and-run",
      "--no-sandbox",
    ],
  };
}

export function windowsInstallCommand(installer) {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath ${quotePowerShell(installer)} -ArgumentList '/S' -Wait`,
    ],
  };
}

export function windowsInstalledExe(localAppData) {
  return path.win32.join(localAppData, "Programs", "VNBot", "VNBot.exe");
}

export function windowsUninstallCommand(installDir) {
  const uninstaller = path.win32.join(installDir, "Uninstall VNBot.exe");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath ${quotePowerShell(uninstaller)} -ArgumentList '/S', ${quotePowerShell(`_?=${installDir}`)} -Wait`,
    ],
  };
}

export function macAttachCommand(installer) {
  return {
    command: "hdiutil",
    args: ["attach", "-nobrowse", "-readonly", "-plist", installer],
  };
}

export function macMountPoint(plist) {
  const match = plist.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  if (!match?.[1]) throw new Error("The dmg did not mount.");
  return match[1];
}

export function macAppBinary(mountPoint) {
  return path.posix.join(mountPoint, "VNBot.app", "Contents", "MacOS", "VNBot");
}

export function macDetachCommand(mountPoint) {
  return { command: "hdiutil", args: ["detach", "-quiet", mountPoint] };
}

async function oneInstaller(outDir, extension) {
  const names = (await readdir(outDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => entry.name);
  if (names.length !== 1) {
    throw new Error(`Expected one ${extension} installer in ${outDir}, found ${names.length}`);
  }
  return path.join(outDir, names[0]);
}

export async function packagedSmokePlan({ runner, outDir, profile }) {
  const planned = planStagingDesktop(
    JSON.parse(await readFile(path.join(repoRoot, "apps/desktop/package.json"), "utf8")).build,
    runner,
  );
  const resolvedProfile = assertSmokeProfile(profile);
  await mkdir(resolvedProfile, { recursive: true });
  const existing = await readdir(resolvedProfile);
  if (existing.length > 0) throw new Error("Smoke profile must start empty.");
  const extension =
    planned.platform === "linux" ? ".AppImage" : planned.platform === "win32" ? ".exe" : ".dmg";
  const installer = await oneInstaller(outDir, extension);
  return {
    kind: planned.platform === "linux" ? "appimage" : planned.platform === "win32" ? "nsis" : "dmg",
    installer,
    profile: resolvedProfile,
    env: smokeProcessEnv(process.env, resolvedProfile),
  };
}

function captureCommand(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let killAfter;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killAfter);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const killTree = (signal) => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    timer = setTimeout(() => killTree("SIGTERM"), SMOKE_TIMEOUT_MS);
    killAfter = setTimeout(() => killTree("SIGKILL"), SMOKE_TIMEOUT_MS + 10_000);
    child.on("close", (code) => {
      finish({ stdout, stderr, code: code ?? 1 });
    });
    child.on("error", (error) => {
      finish({ stdout, stderr: `${stderr}${error.message}\n`, code: 1 });
    });
  });
}

export async function copyLogFiles(directory, dest, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : path.join(prefix, entry.name);
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await copyLogFiles(full, dest, relative);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
    const target = path.join(dest, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(full, target);
  }
}

export async function launchPackagedApp(plan, baseEnv = process.env) {
  if (plan.kind === "appimage") {
    await chmod(plan.installer, 0o755);
    const command = linuxCommand(plan.installer);
    return captureCommand(command.command, command.args, plan.env);
  }
  if (plan.kind === "nsis") {
    const localAppData = baseEnv.LOCALAPPDATA;
    if (!localAppData) throw new Error("Windows smoke requires LOCALAPPDATA.");
    const install = windowsInstallCommand(plan.installer);
    const installed = await captureCommand(install.command, install.args, baseEnv);
    if (installed.code !== 0) return installed;
    const installDir = path.win32.join(localAppData, "Programs", "VNBot");
    const exe = windowsInstalledExe(localAppData);
    try {
      await access(exe);
    } catch {
      return {
        stdout: installed.stdout,
        stderr: `${installed.stderr}Installed VNBot.exe was not found.\n`,
        code: 1,
      };
    }
    try {
      return await captureCommand(exe, [], plan.env);
    } finally {
      const uninstall = windowsUninstallCommand(installDir);
      await captureCommand(uninstall.command, uninstall.args, baseEnv);
    }
  }
  const attach = macAttachCommand(plan.installer);
  const mounted = spawnSync(attach.command, attach.args, { encoding: "utf8" });
  if (mounted.status !== 0) {
    return {
      stdout: mounted.stdout ?? "",
      stderr: `${mounted.stderr ?? ""}The dmg did not mount.\n`,
      code: mounted.status ?? 1,
    };
  }
  let mount = "";
  try {
    mount = macMountPoint(mounted.stdout ?? "");
    return await captureCommand(macAppBinary(mount), [], plan.env);
  } catch (error) {
    return {
      stdout: mounted.stdout ?? "",
      stderr: `${mounted.stderr ?? ""}${error instanceof Error ? error.message : "The dmg did not mount."}\n`,
      code: 1,
    };
  } finally {
    if (mount !== "") {
      const detach = macDetachCommand(mount);
      spawnSync(detach.command, detach.args, { encoding: "utf8" });
    }
  }
}

export async function runInstallerSmoke(options, launch = launchPackagedApp) {
  let plan;
  try {
    plan = await packagedSmokePlan(options);
  } catch (error) {
    await mkdir(path.dirname(options.log), { recursive: true });
    await writeFile(
      options.log,
      `${error instanceof Error ? error.message : "Smoke launch failed."}\n`,
    );
    throw error;
  }
  let captured;
  try {
    captured = await launch(plan);
  } catch (error) {
    captured = {
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Smoke launch failed."}\n`,
      code: 1,
    };
  }
  const verdict = acceptSmokeOutput(captured.stdout, captured.code);
  const body = `${captured.stdout}${captured.stdout.endsWith("\n") || captured.stdout === "" ? "" : "\n"}${captured.stderr}`;
  await mkdir(path.dirname(options.log), { recursive: true });
  await writeFile(options.log, body);
  await copyLogFiles(plan.profile, path.join(path.dirname(options.log), "profile-logs"));
  if (!verdict.ok) throw new Error(verdict.reason);
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) throw new Error(`Unsupported argument: ${flag ?? ""}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    flags[flag.slice(2)] = value;
  }
  return flags;
}

function required(flags, name) {
  const value = flags[name];
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  if (command === "plan") {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, "apps/desktop/package.json"), "utf8"),
    );
    const plan = planStagingDesktop(pkg.build, required(flags, "runner"));
    process.stdout.write(`${plan.args.join("\n")}\n`);
    return;
  }
  if (command === "prepare-current" || command === "prepare-legacy") {
    const input = {
      root: required(flags, "root"),
      major: required(flags, "major"),
      dest: required(flags, "dest"),
    };
    const prefix =
      command === "prepare-current"
        ? await prepareCurrentPrefix(input)
        : await prepareLegacyPrefix(input);
    process.stdout.write(`${prefix}\n`);
    return;
  }
  if (command === "artifacts") {
    const pkg = JSON.parse(
      await readFile(path.join(repoRoot, "apps/desktop/package.json"), "utf8"),
    );
    const plan = planStagingDesktop(pkg.build, required(flags, "runner"));
    await verifyInstallers({
      outDir: required(flags, "out"),
      extensions: plan.extensions,
      checksumPath: required(flags, "checksums"),
    });
    return;
  }
  if (command === "require-public") {
    const distribution = assertStagingDistribution(process.env);
    const pin = readPublicPin(distribution.identityPin);
    process.stdout.write(
      `public-pin=accepted\nportal=${distribution.portalOrigin}\nissuer=${pin?.issuer ?? ""}\n`,
    );
    return;
  }
  if (command === "smoke") {
    await runInstallerSmoke({
      runner: required(flags, "runner"),
      outDir: required(flags, "out"),
      profile: required(flags, "profile"),
      log: required(flags, "log"),
    });
    return;
  }
  throw new Error(`Unsupported command: ${command ?? ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Staging desktop verify failed."}\n`,
    );
    process.exitCode = 1;
  });
}
