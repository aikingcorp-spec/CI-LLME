import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSmokeProfile,
  copyLogFiles,
  linuxCommand,
  macAppBinary,
  macMountPoint,
  packagedSmokePlan,
  planStagingDesktop,
  prepareCurrentPrefix,
  prepareLegacyPrefix,
  repoRoot,
  runInstallerSmoke,
  SMOKE_TIMEOUT_MS,
  smokeProcessEnv,
  verifyInstallers,
  windowsInstallCommand,
  windowsInstalledExe,
} from "./staging-desktop-verify.mjs";

const pkg = JSON.parse(await readFile(path.join(repoRoot, "apps/desktop/package.json"), "utf8"));

test("plans unsigned installers from the desktop package targets", () => {
  const linux = planStagingDesktop(pkg.build, "ubuntu-24.04");
  assert.deepEqual(linux.extensions, [".AppImage", ".deb"]);
  assert.deepEqual(linux.args, ["--linux", "--x64", "--publish", "never", "-c.publish=null"]);

  const windows = planStagingDesktop(pkg.build, "windows-2025");
  assert.deepEqual(windows.extensions, [".exe", ".msi"]);
  assert.ok(windows.args.includes("--win"));
  assert.ok(windows.args.includes("--x64"));
  assert.equal(windows.args[windows.args.indexOf("--publish") + 1], "never");
  assert.ok(windows.args.includes("-c.publish=null"));

  const intel = planStagingDesktop(pkg.build, "macos-26-intel");
  const arm = planStagingDesktop(pkg.build, "macos-26");
  assert.deepEqual(intel.extensions, [".dmg", ".zip"]);
  assert.deepEqual(arm.extensions, [".dmg", ".zip"]);
  assert.ok(intel.args.includes("--x64"));
  assert.ok(arm.args.includes("--arm64"));
  assert.ok(intel.args.includes("-c.mac.notarize=false"));
  assert.ok(intel.args.includes("-c.mac.identity=null"));
  assert.ok(!arm.args.includes("-c.forceCodeSigning=true"));
  assert.throws(() => planStagingDesktop(pkg.build, "macos-13"), /Unsupported staging runner/);
});

test("checksums the expected installers and rejects an update feed", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "staging-desktop-artifacts-"));
  try {
    await writeFile(path.join(out, "VNBot.AppImage"), "appimage");
    await writeFile(path.join(out, "VNBot.deb"), "deb");
    const checksums = path.join(out, "SHA256SUMS");
    const body = await verifyInstallers({
      outDir: out,
      extensions: [".AppImage", ".deb"],
      checksumPath: checksums,
    });
    assert.match(body, /^[a-f0-9]{64} {2}VNBot\.AppImage$/m);
    assert.match(body, /^[a-f0-9]{64} {2}VNBot\.deb$/m);
    assert.equal(await readFile(checksums, "utf8"), body);
    await assert.rejects(
      verifyInstallers({ outDir: out, extensions: [".dmg"], checksumPath: checksums }),
      /Expected one \.dmg installer/,
    );

    await writeFile(path.join(out, "VNBot.AppImage.blockmap"), "delta");
    const withBlockmap = await verifyInstallers({
      outDir: out,
      extensions: [".AppImage", ".deb"],
      checksumPath: checksums,
    });
    assert.equal(withBlockmap.includes("blockmap"), false);

    await writeFile(path.join(out, "latest-linux.yml"), "version: 0.4.0\n");
    await assert.rejects(
      verifyInstallers({ outDir: out, extensions: [".AppImage", ".deb"], checksumPath: checksums }),
      /Update feed files are present/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("rejects a feed embedded in the unpacked app", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "staging-desktop-unpacked-"));
  try {
    await writeFile(path.join(out, "VNBot.AppImage"), "appimage");
    await writeFile(path.join(out, "VNBot.deb"), "deb");
    const resources = path.join(out, "linux-unpacked", "resources");
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(resources, "app-update.yml"), "provider: generic\n");
    await assert.rejects(
      verifyInstallers({
        outDir: out,
        extensions: [".AppImage", ".deb"],
        checksumPath: path.join(out, "SHA256SUMS"),
      }),
      /app-update\.yml/,
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

async function writePostgres(layout) {
  await mkdir(layout.binDir, { recursive: true });
  await mkdir(layout.libDir, { recursive: true });
  await mkdir(layout.shareDir, { recursive: true });
  await writeFile(path.join(layout.binDir, "postgres"), "postgres-bin");
  await writeFile(path.join(layout.libDir, "libpq.so"), "lib");
  await writeFile(path.join(layout.shareDir, "postgres.bki"), "bki");
}

test("copies a Debian prefix without links that leave it and stages a legacy prefix inside the bundle root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "staging-desktop-pg-"));
  try {
    await writePostgres({
      binDir: path.join(root, "lib", "postgresql", "18", "bin"),
      libDir: path.join(root, "lib", "postgresql", "18", "lib"),
      shareDir: path.join(root, "share", "postgresql", "18"),
    });
    await writePostgres({
      binDir: path.join(root, "lib", "postgresql", "16", "bin"),
      libDir: path.join(root, "lib", "postgresql", "16", "lib"),
      shareDir: path.join(root, "share", "postgresql", "16"),
    });
    const currentDest = path.join(root, "current");
    const legacyDest = path.join(root, "legacy");
    await symlink(
      "/nonexistent/dicts/en_us.dict",
      path.join(root, "share", "postgresql", "18", "en_us.dict"),
    );
    const current = await prepareCurrentPrefix({
      root,
      major: 18,
      dest: currentDest,
      platform: "linux",
    });
    assert.equal(current, path.resolve(currentDest));
    assert.equal(
      await readFile(path.join(current, "share", "postgresql", "18", "postgres.bki"), "utf8"),
      "bki",
    );
    await assert.rejects(access(path.join(current, "share", "postgresql", "18", "en_us.dict")));
    const legacy = await prepareLegacyPrefix({
      root,
      major: 16,
      dest: legacyDest,
      platform: "linux",
    });
    assert.equal(
      await readFile(path.join(legacy, "share", "postgresql", "postgres.bki"), "utf8"),
      "bki",
    );
    assert.equal(await readFile(path.join(legacy, "bin", "postgres"), "utf8"), "postgres-bin");
    assert.equal(await readFile(path.join(legacy, "lib", "postgresql", "libpq.so"), "utf8"), "lib");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stages a Homebrew prefix so postgres.bki sits at the share root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "staging-desktop-brew-"));
  try {
    const dest = path.join(root, "staged");
    await writePostgres({
      binDir: path.join(root, "bin"),
      libDir: path.join(root, "lib"),
      shareDir: path.join(root, "share", "postgresql"),
    });
    await writeFile(path.join(root, "lib", "libpq.dylib"), "dylib");
    const prefix = await prepareCurrentPrefix({
      root,
      major: 18,
      dest,
      platform: "darwin",
    });
    assert.equal(prefix, path.resolve(dest));
    assert.equal(await readFile(path.join(prefix, "share", "postgres.bki"), "utf8"), "bki");
    const legacy = await prepareLegacyPrefix({
      root,
      major: 18,
      dest: path.join(root, "legacy"),
      platform: "darwin",
    });
    assert.equal(await readFile(path.join(legacy, "lib", "libpq.dylib"), "utf8"), "dylib");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launches the packaged installer and strips runtime identity, web, and mail overrides", async () => {
  assert.equal(SMOKE_TIMEOUT_MS, 180_000);
  const profile = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-smoke-"));
  const out = await mkdtemp(path.join(tmpdir(), "staging-desktop-smoke-"));
  const log = path.join(out, "smoke.log");
  try {
    await writeFile(path.join(out, "VNBot.AppImage"), "not-a-real-image");
    await assert.rejects(
      packagedSmokePlan({ runner: "ubuntu-24.04", outDir: out, profile: out }),
      /vnbot-desktop-smoke/,
    );
    const plan = await packagedSmokePlan({
      runner: "ubuntu-24.04",
      outDir: out,
      profile,
    });
    assert.equal(plan.kind, "appimage");
    assert.equal(plan.installer, path.join(out, "VNBot.AppImage"));
    assert.deepEqual(linuxCommand(plan.installer).args.slice(-2), [
      "--appimage-extract-and-run",
      "--no-sandbox",
    ]);
    const env = smokeProcessEnv(
      {
        PATH: "/usr/bin",
        RAKAZO_IDENTITY_PIN: '{"publicKey":"pin-public-material"}',
        RAKAZO_CLOUD_URL: "https://stage.example.test",
        RAKAZO_WEB_URL: "data:text/html,skipped",
        RAKAZO_FORCE_SETUP: "1",
        SMTP_URL: "smtp://secret",
        SIGNUP_ALLOWLIST: "person@example.test",
      },
      profile,
    );
    assert.equal(env.RAKAZO_DESKTOP_SMOKE, "1");
    assert.equal(env.RAKAZO_PERFORMANCE_USER_DATA, profile);
    assert.equal(env.RAKAZO_IDENTITY_PIN, undefined);
    assert.equal(env.RAKAZO_WEB_URL, undefined);
    assert.equal(env.RAKAZO_FORCE_SETUP, undefined);
    assert.equal(env.SMTP_URL, undefined);
    assert.equal(env.SIGNUP_ALLOWLIST, undefined);
    assert.equal(
      windowsInstalledExe("C:\\Users\\runner\\AppData\\Local"),
      path.win32.join("C:\\Users\\runner\\AppData\\Local", "Programs", "VNBot", "VNBot.exe"),
    );
    assert.match(windowsInstallCommand(plan.installer).args.at(-1) ?? "", /ArgumentList '\/S'/);
    assert.equal(macAppBinary("/Volumes/VNBot"), "/Volumes/VNBot/VNBot.app/Contents/MacOS/VNBot");
    assert.equal(
      macMountPoint("<key>mount-point</key><string>/Volumes/VNBot</string>"),
      "/Volumes/VNBot",
    );
    assert.throws(() => assertSmokeProfile("/home/person/.config/VNBot"), /vnbot-desktop-smoke/);

    const ready = `RAKAZO_DESKTOP_SMOKE ready postgres=up api=up worker=up web=http://127.0.0.1:43123\nRAKAZO_DESKTOP_SMOKE ok http://127.0.0.1:43123\n`;
    await assert.rejects(
      runInstallerSmoke({ runner: "ubuntu-24.04", outDir: out, profile, log }, async () => ({
        stdout: "RAKAZO_DESKTOP_SMOKE ok http://127.0.0.1:43123\n",
        stderr: "",
        code: 0,
      })),
      /loopback postgres, api, worker, and web/,
    );
    await rmProfile(profile);
    await runInstallerSmoke({ runner: "ubuntu-24.04", outDir: out, profile, log }, async () => ({
      stdout: ready,
      stderr: "stage\n",
      code: 0,
    }));
    assert.match(
      await readFile(log, "utf8"),
      /RAKAZO_DESKTOP_SMOKE ok http:\/\/127\.0\.0\.1:43123/,
    );
    await writeFile(path.join(profile, "credentials.json"), '{"auth":"secret-value"}');
    await mkdir(path.join(profile, "native"), { recursive: true });
    await writeFile(path.join(profile, "native", "postgres.log"), "ready\n");
    const logs = path.join(out, "profile-logs");
    await copyLogFiles(profile, logs);
    assert.equal(await readFile(path.join(logs, "native", "postgres.log"), "utf8"), "ready\n");
    await assert.rejects(readFile(path.join(logs, "credentials.json"), "utf8"));
  } finally {
    await rm(out, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});

async function rmProfile(profile) {
  const { rm } = await import("node:fs/promises");
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
}

test("the workflow stays on staging branches and read-only contents", async () => {
  const workflow = await readFile(
    path.join(repoRoot, ".github/workflows/staging-desktop.yml"),
    "utf8",
  );
  const setup = await readFile(
    path.join(repoRoot, ".github/actions/setup-workspace/action.yml"),
    "utf8",
  );
  assert.match(workflow, /branches:\n\s+- "staging\/\*\*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /id-token:/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /pack:linux/);
  assert.doesNotMatch(workflow, /RAKAZO_DESKTOP_RELEASE/);
  assert.doesNotMatch(workflow, /gh release/);
  for (const runner of ["ubuntu-24.04", "windows-2025", "macos-26-intel", "macos-26"]) {
    assert.match(workflow, new RegExp(runner));
  }
  assert.match(workflow, /uses: \.\/\.github\/actions\/setup-workspace/);
  assert.match(workflow, /electron: "true"/);
  assert.match(workflow, /pnpm db:generate/);
  assert.match(workflow, /pnpm --filter @rakazo\/desktop test/);
  assert.match(workflow, /pnpm --filter @rakazo\/api build/);
  assert.match(workflow, /pnpm --filter @rakazo\/worker build/);
  assert.match(workflow, /pnpm --filter @rakazo\/web build/);
  assert.match(workflow, /pnpm --filter @rakazo\/desktop build\n/);
  assert.match(workflow, /run build:native \\\n\s+--node /);
  assert.match(workflow, /plan --runner/);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.match(workflow, /node --test \.github\/scripts\/staging-desktop-verify\.test\.mjs/);
  assert.match(workflow, /require-public/);
  assert.match(workflow, /vars\.RAKAZO_IDENTITY_PIN/);
  assert.match(workflow, /vars\.RAKAZO_CLOUD_URL/);
  assert.doesNotMatch(workflow, /RAKAZO_WEB_URL/);
  assert.doesNotMatch(workflow, /RAKAZO_FORCE_SETUP/);
  assert.match(workflow, /--profile "\$RUNNER_TEMP\/vnbot-desktop-smoke"/);
  const requireAt = workflow.indexOf("require-public");
  const buildAt = workflow.indexOf("pnpm --filter @rakazo/desktop build");
  const smokeAt = workflow.indexOf("Smoke the packaged app");
  const uploadAt = workflow.indexOf("Upload installers and checksums");
  const logsAt = workflow.indexOf("Upload smoke diagnostics");
  assert.ok(requireAt > 0 && requireAt < buildAt);
  assert.ok(smokeAt > buildAt && smokeAt < uploadAt && uploadAt < logsAt);
  assert.match(workflow.slice(logsAt), /if: always\(\)/);
  assert.match(setup, /node-version: 24/);
  assert.match(setup, /pnpm install --frozen-lockfile/);
});

test("require-public accepts a staging pin without printing key material", () => {
  const script = fileURLToPath(new URL("./staging-desktop-verify.mjs", import.meta.url));
  const pin = {
    issuer: "https://stage.example.test",
    audience: "vnbot-native",
    publicKey: "pin-public-material",
    centralAuthUrl: "https://stage.example.test/api/auth",
    centralOrigin: "https://stage.example.test",
  };
  const accepted = spawnSync(process.execPath, [script, "require-public"], {
    env: {
      ...process.env,
      RAKAZO_IDENTITY_PIN: JSON.stringify(pin),
      RAKAZO_CLOUD_URL: pin.centralOrigin,
    },
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /^public-pin=accepted\nportal=https:\/\/stage\.example\.test\n/m);
  assert.doesNotMatch(`${accepted.stdout}${accepted.stderr}`, /pin-public-material/);
  const missing = spawnSync(process.execPath, [script, "require-public"], {
    env: { ...process.env, RAKAZO_IDENTITY_PIN: "", RAKAZO_CLOUD_URL: "" },
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /RAKAZO_IDENTITY_PIN/);
  assert.doesNotMatch(missing.stderr, /pin-public-material/);
});
