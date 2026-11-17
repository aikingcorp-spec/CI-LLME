import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  copyLegacyFiles,
  legacyFileSources,
  planLegacyUpgrade,
  readLegacyNativeSecrets,
  readLegacyUpgradeReceipt,
  writeLegacyUpgradeReceipt,
} from "./legacy-upgrade.js";
import { assertNativeProfileSafe, prepareCurrentNativeLayout } from "./native-stack.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temp(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fingerprint(root: string) {
  const lines: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) lines.push(`link:${relative}`);
      else if (entry.isDirectory()) await walk(full);
      else
        lines.push(
          `${relative}:${createHash("sha256")
            .update(await readFile(full))
            .digest("hex")}`,
        );
    }
  }
  await walk(root);
  return lines.sort().join("\n");
}

const legacyEnv = {
  POSTGRES_PASSWORD: "ab".repeat(16),
  POSTGRES_APP_PASSWORD: "ab".repeat(16),
  ENCRYPTION_KEY: "cd".repeat(32),
  BETTER_AUTH_SECRET: "ef".repeat(32),
  SCREEN_PROXY_SECRET: "ef".repeat(32),
  RAKAZO_DESKTOP_STACK_TOKEN: "ab".repeat(32),
};

const ownerPassword = "12".repeat(24);

async function pg16Profile() {
  const root = await temp("legacy-upgrade-");
  await mkdir(path.join(root, "pg", "data"), { recursive: true });
  await writeFile(path.join(root, "pg", "data", "PG_VERSION"), "16\n");
  await writeFile(path.join(root, "native-stack-env"), JSON.stringify(legacyEnv), {
    mode: 0o600,
  });
  await writeFile(path.join(root, "pg", ".owner-password"), `${ownerPassword}\n`, { mode: 0o600 });
  return root;
}

it("copies a stopped PostgreSQL 16 profile and keeps it closed to the current startup", async () => {
  const profile = await pg16Profile();
  const before = await fingerprint(profile);
  await expect(planLegacyUpgrade({ profile })).resolves.toEqual({ action: "copy" });
  await expect(assertNativeProfileSafe(profile)).rejects.toThrow("copy-only migration");
  expect(await fingerprint(profile)).toBe(before);
  await expect(planLegacyUpgrade({ profile: path.join(profile, "missing") })).resolves.toEqual({
    action: "fresh",
  });
});

it("refuses a symlink, a live source, or another major without changing the profile", async () => {
  const profile = await pg16Profile();
  const target = await temp("legacy-link-target-");
  const linked = path.join(target, "linked-profile");
  await symlink(profile, linked);
  await expect(planLegacyUpgrade({ profile: linked })).resolves.toEqual({
    action: "blocked",
    reason: "symlink",
  });
  const pid = path.join(profile, "pg", "data", "postmaster.pid");
  await writeFile(pid, "1\n");
  const live = await fingerprint(profile);
  await expect(planLegacyUpgrade({ profile })).resolves.toEqual({
    action: "blocked",
    reason: "live-source",
  });
  expect(await fingerprint(profile)).toBe(live);
  await rm(pid);
  await writeFile(path.join(profile, "pg", "data", "PG_VERSION"), "15\n");
  await expect(planLegacyUpgrade({ profile })).resolves.toEqual({
    action: "blocked",
    reason: "version",
  });
});

it("reuses the 0.3.9 sign-in and encryption keys and refuses a layout saved with others", async () => {
  const profile = await pg16Profile();
  const kept = await readLegacyNativeSecrets(profile);
  expect(kept).toEqual({
    owner: ownerPassword,
    auth: legacyEnv.BETTER_AUTH_SECRET,
    encryption: legacyEnv.ENCRYPTION_KEY,
  });
  const prepared = await prepareCurrentNativeLayout(profile, kept);
  expect(prepared.secrets).toMatchObject({ auth: kept.auth, encryption: kept.encryption });
  expect(prepared.secrets.owner).not.toBe(kept.owner);
  await expect(prepareCurrentNativeLayout(profile, kept)).resolves.toMatchObject({
    secrets: prepared.secrets,
  });
  await expect(
    prepareCurrentNativeLayout(profile, { ...kept, encryption: "00".repeat(32) }),
  ).rejects.toThrow("Unrecognized native data directory.");

  await writeFile(path.join(profile, "native-stack-env"), JSON.stringify({ ENCRYPTION_KEY: "x" }));
  await expect(readLegacyNativeSecrets(profile)).rejects.toThrow("Invalid native credentials.");
});

it("records the import phase and rejects an unrecognized receipt", async () => {
  const root = await temp("legacy-receipt-");
  await expect(readLegacyUpgradeReceipt(root)).resolves.toBeNull();
  const receipt = { version: 1, phase: "importing", sourceDigest: "a".repeat(64) } as const;
  await writeLegacyUpgradeReceipt(root, receipt);
  await expect(readLegacyUpgradeReceipt(root)).resolves.toEqual(receipt);
  await writeFile(path.join(root, "legacy-upgrade.json"), JSON.stringify({ version: 2 }));
  await expect(readLegacyUpgradeReceipt(root)).rejects.toThrow("Unrecognized");
});

it("copies only a folder shaped like the 0.3.9 file store", async () => {
  const root = await temp("legacy-files-");
  const store = path.join(root, "launch", "data");
  await mkdir(path.join(store, "artifacts", "space"), { recursive: true });
  await writeFile(path.join(store, "artifacts", "space", "file"), "sealed");
  const personal = path.join(root, "home", "data");
  await mkdir(personal, { recursive: true });
  await writeFile(path.join(personal, "notes.txt"), "not ours");
  const sources = await legacyFileSources([
    store,
    personal,
    path.join(root, "missing"),
    path.join(root, "launch", "..", "launch", "data"),
  ]);
  expect(sources).toEqual([store]);
  const destination = path.join(root, "files");
  await copyLegacyFiles(sources, destination);
  await writeFile(path.join(destination, "artifacts", "space", "file"), "partial");
  await copyLegacyFiles(sources, destination);
  expect(await readFile(path.join(destination, "artifacts", "space", "file"), "utf8")).toBe(
    "sealed",
  );
  expect(await readFile(path.join(store, "artifacts", "space", "file"), "utf8")).toBe("sealed");
});
