import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
  EXAMPLE_SUPERVISOR_TOKEN_PLACEHOLDER,
} from "@rakazo/core/node/secrets-guard";
import { expect, it } from "vitest";
import { desktopMcpEnv, desktopMcpStdioAllowedCommands } from "./mcp-stdio-defaults.js";
import { CURRENT_NATIVE_DIRECTORY } from "./native-postgres-layout.js";
import {
  archiveLegacy039Profile,
  assertNativeBundleManifest,
  assertNativeBundleTree,
  assertNativeProfileSafe,
  detectNativeSandboxProvider,
  ensureNativeDeviceFile,
  NativeStackController,
  nativeBundleDirectory,
  nativeBundleManifest,
  nativeEnvironment,
  nativeHostComputerEnv,
  prepareCurrentNativeLayout,
  readNativeDeviceConfig,
  selectDesktopStack,
} from "./native-stack.js";
import { writePrivateFile } from "./setup-store.js";

const device = {
  kind: "local",
  issuer: "https://identity.example.test",
  audience: "vnbot-local",
  publicKey: "ed25519-public",
  deviceId: "device-1",
  centralAuthUrl: "https://identity.example.test/api/auth",
  centralOrigin: "https://app.example.test",
};

const pin = {
  issuer: device.issuer,
  audience: device.audience,
  publicKey: device.publicKey,
  centralAuthUrl: device.centralAuthUrl,
  centralOrigin: device.centralOrigin,
};

async function tempProfile() {
  return mkdtemp(path.join(tmpdir(), "native-stack-"));
}

it("keeps repository credentials and database targets out of native children", () => {
  expect(
    nativeEnvironment({
      PATH: "/fake/bin",
      DATABASE_URL: "postgresql://secret@127.0.0.1/db",
      NODE_OPTIONS: "--require /tmp/inject.js",
      ENCRYPTION_KEY: "secret",
      EMAIL_API_KEY: "secret",
      SANDBOX_HOST_TOKEN: "secret",
      RAKAZO_LOAD_ROOT_ENV: "true",
    }),
  ).toEqual({ PATH: "/fake/bin", NODE_ENV: "production", RAKAZO_LOAD_ROOT_ENV: "false" });
});

it("uses native for packaged apps and leaves development on Docker without a bundle", () => {
  expect(selectDesktopStack({ packaged: true, nativeBundlePresent: false })).toBe("native");
  expect(selectDesktopStack({ packaged: false, nativeBundlePresent: false })).toBe("docker");
  expect(selectDesktopStack({ packaged: false, nativeBundlePresent: true })).toBe("native");
  expect(
    nativeBundleDirectory({
      packaged: true,
      resourcesPath: "/resources",
      appPath: "/app",
    }),
  ).toBe(path.join("/resources", "native"));
});

it("refuses every legacy cluster without changing its files", async () => {
  const root = await tempProfile();
  try {
    await expect(assertNativeProfileSafe(root)).resolves.toBeUndefined();
    const version = path.join(root, "pg", "PG_VERSION");
    await mkdir(path.dirname(version));
    await writeFile(version, "18");
    await expect(assertNativeProfileSafe(root)).rejects.toThrow("copy-only migration");
    expect(await readFile(version, "utf8")).toBe("18");
    const stack = new NativeStackController({
      profile: root,
      bundle: path.join(root, "missing-bundle"),
      env: {},
      issuerPin: JSON.stringify(pin),
      onState() {},
    });
    const state = await stack.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toContain("copy-only migration");
    expect(await readdir(root)).toEqual(["pg"]);
    expect(await readFile(version, "utf8")).toBe("18");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("requires a local device identity before creating current data", async () => {
  const root = await tempProfile();
  try {
    await expect(readNativeDeviceConfig(root)).rejects.toThrow(
      "Native identity setup is required.",
    );
    const stack = new NativeStackController({
      profile: root,
      bundle: path.join(root, "missing-bundle"),
      env: { DATABASE_URL: "postgresql://secret@127.0.0.1/db" },
      onState() {},
    });
    const state = await stack.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe("Native identity setup is required.");
    expect(state.message).not.toContain("secret");
    expect(await readdir(root)).toEqual([]);
    await writeFile(
      path.join(root, "native-device.json"),
      JSON.stringify({ ...device, kind: "issuer", privateKey: "secret" }),
    );
    await expect(readNativeDeviceConfig(root)).rejects.toThrow(
      "Native identity setup is required.",
    );
    await writeFile(path.join(root, "native-device.json"), JSON.stringify(device));
    const admitted = await stack.start();
    expect(admitted.phase).toBe("failed");
    expect(admitted.message).not.toContain(root);
    expect(await readdir(root)).toEqual(["native-device.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("binds one device id to the pinned issuer and does not create database files", async () => {
  const root = await tempProfile();
  try {
    const first = await ensureNativeDeviceFile(root, pin);
    expect(await ensureNativeDeviceFile(root, pin)).toEqual(first);
    expect(first.deviceId).toMatch(/^[a-f0-9]{64}$/);
    const file = path.join(root, "native-device.json");
    const before = await readFile(file, "utf8");
    await expect(ensureNativeDeviceFile(root, { ...pin, audience: "other" })).rejects.toThrow(
      "Native identity setup is required.",
    );
    expect(await readFile(file, "utf8")).toBe(before);

    const stack = new NativeStackController({
      profile: root,
      bundle: path.join(root, "missing-bundle"),
      env: { DATABASE_URL: "postgresql://secret@127.0.0.1/db" },
      issuerPin: JSON.stringify({ ...pin, privateKey: "secret-key" }),
      onState() {},
    });
    const rejected = await stack.start();
    expect(rejected.phase).toBe("failed");
    expect(rejected.message).toBe("Invalid identity exchange configuration");
    expect(rejected.message).not.toContain("secret-key");
    expect(await readFile(file, "utf8")).toBe(before);

    const admitted = new NativeStackController({
      profile: root,
      bundle: path.join(root, "missing-bundle"),
      env: {},
      issuerPin: JSON.stringify(pin),
      onState() {},
    });
    const started = await admitted.start();
    expect(started.message ?? "").not.toContain(root);
    expect(await readdir(root)).toEqual(["native-device.json"]);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      deviceId: string;
      devicePrivateKey?: string;
    };
    expect(saved.deviceId).toBe(first.deviceId);
    expect(saved.devicePrivateKey).toContain("PRIVATE KEY");
    expect(first.devicePrivateKey).toBe(saved.devicePrivateKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("persists credentials and the loopback origin without following a foreign directory", async () => {
  const root = await tempProfile();
  try {
    const marked = path.join(root, CURRENT_NATIVE_DIRECTORY);
    await mkdir(marked);
    await writePrivateFile(path.join(marked, "layout"), "foreign");
    await expect(prepareCurrentNativeLayout(root)).rejects.toThrow(
      "Unrecognized native data directory.",
    );
    expect(await readFile(path.join(marked, "layout"), "utf8")).toBe("foreign");
    await rm(marked, { recursive: true });

    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "kept"), "kept");
    await symlink(outside, marked);
    await expect(prepareCurrentNativeLayout(root)).rejects.toThrow(
      "Unrecognized native data directory.",
    );
    expect(await readFile(path.join(outside, "kept"), "utf8")).toBe("kept");
    await rm(marked);

    const first = await prepareCurrentNativeLayout(root);
    const second = await prepareCurrentNativeLayout(root);
    expect(second.secrets).toEqual(first.secrets);
    expect(second.webPort).toBe(first.webPort);
    expect(first.needsInit).toBe(true);
    expect(second.needsInit).toBe(true);
    const secretFile = path.join(first.root, "credentials.json");
    expect((await lstat(secretFile)).mode & 0o077).toBe(0);

    await writeFile(path.join(first.root, "web-port"), "80");
    await expect(prepareCurrentNativeLayout(root)).rejects.toThrow("Invalid native origin.");
    await writeFile(path.join(first.root, "web-port"), String(first.webPort));

    const version = path.join(first.dataDir, "PG_VERSION");
    await mkdir(first.dataDir);
    await writeFile(version, "16\n");
    await expect(prepareCurrentNativeLayout(root)).rejects.toThrow(
      "Native database version mismatch.",
    );
    expect(await readFile(version, "utf8")).toBe("16\n");
    await rm(first.dataDir, { recursive: true });

    const scratch = path.join(first.root, "data.initializing");
    await mkdir(scratch);
    await writeFile(path.join(scratch, "PG_VERSION"), "18\n");
    await expect(prepareCurrentNativeLayout(root)).rejects.toThrow("inspection");
    expect(await readFile(path.join(scratch, "PG_VERSION"), "utf8")).toBe("18\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps an existing PostgreSQL 18 data directory for the next start", async () => {
  const root = await tempProfile();
  try {
    const first = await prepareCurrentNativeLayout(root);
    const version = path.join(first.dataDir, "PG_VERSION");
    await mkdir(first.dataDir);
    await writeFile(version, "18\n");
    const again = await prepareCurrentNativeLayout(root);
    expect(again.needsInit).toBe(false);
    expect(again.secrets).toEqual(first.secrets);
    expect(again.webPort).toBe(first.webPort);
    expect(await readFile(version, "utf8")).toBe("18\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("accepts a universal macOS bundle on either chip and nowhere else", () => {
  const universal = nativeBundleManifest({ platform: "darwin", arch: "universal" });
  expect(assertNativeBundleManifest(universal, "darwin", "x64")).toBe(universal.files);
  expect(assertNativeBundleManifest(universal, "darwin", "arm64")).toBe(universal.files);
  const linux = nativeBundleManifest({ platform: "linux", arch: "universal" });
  expect(() => assertNativeBundleManifest(linux, "linux", "x64")).toThrow(
    "Native bundle target mismatch.",
  );
});

it("accepts only a PostgreSQL 18 manifest whose files stay inside the bundle", async () => {
  const root = await tempProfile();
  try {
    const manifest = nativeBundleManifest({ platform: process.platform, arch: process.arch });
    expect(manifest.postgresMajor).toBe(18);
    expect(assertNativeBundleManifest(manifest)).toBe(manifest.files);
    expect(() => assertNativeBundleManifest({ ...manifest, postgresMajor: 16 })).toThrow(
      "Native bundle target mismatch.",
    );
    const bundle = path.join(root, "bundle");
    for (const file of Object.keys(manifest.files)) {
      const destination = path.join(bundle, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, "");
    }
    const library = path.join(bundle, "pg/lib");
    const migration = path.join(bundle, "packages/db/prisma/migrations/001_init/migration.sql");
    await mkdir(library, { recursive: true });
    await writeFile(path.join(library, "library"), "fixture");
    await mkdir(path.dirname(migration), { recursive: true });
    await writeFile(migration, "select 1;");
    await assertNativeBundleTree(bundle, manifest.files);
    await rm(migration);
    await expect(assertNativeBundleTree(bundle, manifest.files)).rejects.toThrow(
      "Invalid native bundle asset.",
    );
    await writeFile(migration, "select 1;");
    await rm(path.join(library, "library"));
    await expect(assertNativeBundleTree(bundle, manifest.files)).rejects.toThrow(
      "Invalid native bundle asset.",
    );
    await writeFile(path.join(library, "library"), "fixture");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "kept");
    await symlink(outside, path.join(bundle, "escape"));
    await expect(
      assertNativeBundleTree(bundle, { ...manifest.files, escape: true }),
    ).rejects.toThrow("Invalid native bundle asset.");
    expect(await readFile(outside, "utf8")).toBe("kept");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("gives API and worker the loopback host connection and ignores inherited credentials", () => {
  const managed = "cd".repeat(32);
  const inherited = "ab".repeat(32);
  const parent = nativeEnvironment({
    PATH: "/fake/bin",
    NODE_ENV: "development",
    SANDBOX_PROVIDER: "desktop",
    SANDBOX_HOST_URL: "http://host.docker.internal:45175",
    SANDBOX_HOST_TOKEN: inherited,
  });
  const assigned = nativeHostComputerEnv({
    url: "http://127.0.0.1:45175",
    token: managed,
  });
  const child: NodeJS.ProcessEnv = { ...parent, ...assigned };
  expect(parent).toEqual({
    PATH: "/fake/bin",
    NODE_ENV: "production",
    RAKAZO_LOAD_ROOT_ENV: "false",
  });
  expect(assigned).toEqual({
    SANDBOX_PROVIDER: "none",
    SANDBOX_HOST_URL: "http://127.0.0.1:45175",
    SANDBOX_HOST_TOKEN: managed,
  });
  expect(child.SANDBOX_PROVIDER).toBe("none");
  expect(child.NODE_ENV).toBe("production");
  expect(child.SANDBOX_HOST_URL).toBe("http://127.0.0.1:45175");
  expect(child.SANDBOX_HOST_TOKEN).toBe(managed);
  expect(child.SANDBOX_HOST_URL).not.toContain(managed);
  expect(
    nativeHostComputerEnv({
      url: "http://host.docker.internal:45175",
      token: managed,
    }),
  ).toEqual({
    SANDBOX_PROVIDER: "none",
    SANDBOX_HOST_URL: "",
    SANDBOX_HOST_TOKEN: "",
  });
  expect(nativeHostComputerEnv(undefined)).toEqual({
    SANDBOX_PROVIDER: "none",
    SANDBOX_HOST_URL: "",
    SANDBOX_HOST_TOKEN: "",
  });
});

it("auto-detects Docker sandbox only when daemon, supervisor health, and dedicated token are valid", async () => {
  const token = "a".repeat(64);
  const secrets = { auth: "b".repeat(64), screen: "c".repeat(64) };
  const okDocker = async () => ({ code: 0, stdout: "27.0.3\n", stderr: "" });
  const okFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;

  await expect(
    detectNativeSandboxProvider({
      sourceEnv: {
        PATH: "/usr/bin",
        SANDBOX_SUPERVISOR_TOKEN: token,
        SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091/ignored",
      },
      secrets,
      platform: "linux",
      exists: (file) => file === "/usr/bin/docker",
      runDocker: okDocker,
      fetch: okFetch,
    }),
  ).resolves.toEqual({
    SANDBOX_PROVIDER: "docker",
    SANDBOX_SUPERVISOR_URL: "http://127.0.0.1:7091",
    SANDBOX_SUPERVISOR_TOKEN: token,
  });

  // Missing, short, placeholder, or reused secret tokens stay on none.
  for (const badToken of [
    undefined,
    "",
    "too-short",
    DEV_SUPERVISOR_TOKEN_PLACEHOLDER,
    EXAMPLE_SUPERVISOR_TOKEN_PLACEHOLDER,
    secrets.auth,
    secrets.screen,
  ]) {
    await expect(
      detectNativeSandboxProvider({
        sourceEnv: { PATH: "/usr/bin", SANDBOX_SUPERVISOR_TOKEN: badToken },
        secrets,
        platform: "linux",
        exists: (file) => file === "/usr/bin/docker",
        runDocker: okDocker,
        fetch: okFetch,
      }),
    ).resolves.toEqual({ SANDBOX_PROVIDER: "none" });
  }

  // Missing docker binary or failed daemon check falls back to none.
  await expect(
    detectNativeSandboxProvider({
      sourceEnv: { PATH: "/usr/bin", SANDBOX_SUPERVISOR_TOKEN: token },
      secrets,
      platform: "linux",
      exists: () => false,
      runDocker: okDocker,
      fetch: okFetch,
    }),
  ).resolves.toEqual({ SANDBOX_PROVIDER: "none" });

  await expect(
    detectNativeSandboxProvider({
      sourceEnv: { PATH: "/usr/bin", SANDBOX_SUPERVISOR_TOKEN: token },
      secrets,
      platform: "linux",
      exists: (file) => file === "/usr/bin/docker",
      runDocker: async () => ({ code: 1, stdout: "", stderr: "Cannot connect to Docker daemon" }),
      fetch: okFetch,
    }),
  ).resolves.toEqual({ SANDBOX_PROVIDER: "none" });

  // Unhealthy or unreachable supervisor falls back to none.
  await expect(
    detectNativeSandboxProvider({
      sourceEnv: { PATH: "/usr/bin", SANDBOX_SUPERVISOR_TOKEN: token },
      secrets,
      platform: "linux",
      exists: (file) => file === "/usr/bin/docker",
      runDocker: okDocker,
      fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    }),
  ).resolves.toEqual({ SANDBOX_PROVIDER: "none" });
});

it("enforces all 4 locks when archiving a stopped 0.3.9 profile and keeps setup/device files untouched", async () => {
  const root = await tempProfile();
  try {
    await mkdir(path.join(root, "pg", "data"), { recursive: true });
    await writeFile(path.join(root, "pg", "data", "PG_VERSION"), "16\n");
    await writeFile(path.join(root, "native-stack-env"), "{}");
    await writeFile(path.join(root, "native-api-port"), "3000");
    await writeFile(path.join(root, "native-device.json"), '{"keep":"device"}');
    await writeFile(path.join(root, "setup.json"), '{"keep":"setup"}');

    // Lock 1: native-040/ prevents archiving.
    await mkdir(path.join(root, CURRENT_NATIVE_DIRECTORY));
    await expect(archiveLegacy039Profile(root, { now: () => 123 })).resolves.toEqual({
      archivedDir: null,
      moved: [],
    });
    await rm(path.join(root, CURRENT_NATIVE_DIRECTORY), { recursive: true });

    // Lock 3: postmaster.pid prevents archiving.
    await writeFile(path.join(root, "pg", "data", "postmaster.pid"), "999\n");
    await expect(archiveLegacy039Profile(root, { now: () => 123 })).resolves.toEqual({
      archivedDir: null,
      moved: [],
    });
    await rm(path.join(root, "pg", "data", "postmaster.pid"));

    // Lock 2: symlink marker prevents archiving.
    const outside = await tempProfile();
    await writeFile(path.join(outside, "target"), "keep");
    await symlink(path.join(outside, "target"), path.join(root, "symlink-trap"));
    await rm(path.join(root, "native-api-port"));
    await symlink(path.join(outside, "target"), path.join(root, "native-api-port"));
    await expect(archiveLegacy039Profile(root, { now: () => 123 })).resolves.toEqual({
      archivedDir: null,
      moved: [],
    });
    await rm(path.join(root, "native-api-port"));
    await rm(path.join(root, "symlink-trap"));
    await rm(outside, { recursive: true, force: true });
    await writeFile(path.join(root, "native-api-port"), "3000");

    // Lock 4: stopped 0.3.9 markers move into legacy-039-archived-<ts>/ and setup/device files stay.
    const result = await archiveLegacy039Profile(root, { now: () => 456 });
    expect(result.archivedDir).toBe(path.join(root, "legacy-039-archived-456"));
    expect(result.moved.sort()).toEqual(["native-api-port", "native-stack-env", "pg"]);
    expect((await readdir(root)).sort()).toEqual([
      "legacy-039-archived-456",
      "native-device.json",
      "setup.json",
    ]);
    expect(await readFile(path.join(root, "native-device.json"), "utf8")).toBe('{"keep":"device"}');
    expect(await readFile(path.join(root, "setup.json"), "utf8")).toBe('{"keep":"setup"}');
    expect(
      await readFile(
        path.join(root, "legacy-039-archived-456", "pg", "data", "PG_VERSION"),
        "utf8",
      ),
    ).toBe("16\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports whether NativeStackController has running processes", () => {
  const stack = new NativeStackController({
    profile: "/tmp/unused",
    bundle: "/tmp/unused-bundle",
    env: {},
    onState() {},
  });
  expect(stack.hasProcesses()).toBe(false);
  expect(stack.managedStackRunning()).toBe(false);
});

it("enables curated stdio MCP commands per platform while honouring operator overrides", () => {
  expect(desktopMcpStdioAllowedCommands("darwin")).toBe("npx,node,python,python3");
  expect(desktopMcpStdioAllowedCommands("linux")).toBe("npx,node,python,python3");
  expect(desktopMcpStdioAllowedCommands("win32")).toBe(
    "npx,npx.cmd,node,node.exe,python,python.exe,python3,python3.exe",
  );

  expect(desktopMcpEnv({}, "win32")).toEqual({
    MCP_ALLOW_PRIVATE_ENDPOINT: "true",
    MCP_STDIO_ENABLED: "true",
    MCP_STDIO_ALLOWED_COMMANDS: "npx,npx.cmd,node,node.exe,python,python.exe,python3,python3.exe",
  });

  expect(
    desktopMcpEnv(
      {
        MCP_ALLOW_PRIVATE_ENDPOINT: "false",
        MCP_STDIO_ENABLED: "false",
        MCP_STDIO_ALLOWED_COMMANDS: "node",
      },
      "darwin",
    ),
  ).toEqual({
    MCP_ALLOW_PRIVATE_ENDPOINT: "false",
    MCP_STDIO_ENABLED: "false",
    MCP_STDIO_ALLOWED_COMMANDS: "node",
  });
});
