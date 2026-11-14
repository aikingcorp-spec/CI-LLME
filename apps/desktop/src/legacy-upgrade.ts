import { cp, lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { LEGACY_PROFILE_MARKERS, NATIVE_POSTGRES_MAJOR } from "./native-postgres-layout.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

/** Native data a 0.3.9 profile owns. Electron's own browser data stays where it is. */
export const LEGACY_NATIVE_ENTRIES = ["pg", "native-stack-env", "data"] as const;

/** 0.3.9 cluster identity: owner `rakazo` in database `rakazo`. */
export const LEGACY_CLUSTER = { database: "rakazo", ownerRole: "rakazo" } as const;

export type LegacyUpgradePlan =
  | { action: "fresh" }
  | { action: "copy" }
  | { action: "blocked"; reason: "symlink" | "live-source" | "unreadable" | "version" };

function isEnoent(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathKind(
  file: string,
): Promise<"missing" | "link" | "file" | "directory" | "other" | "unreadable"> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return "link";
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    return isEnoent(error) ? "missing" : "unreadable";
  }
}

/**
 * Reads markers only. It never writes the profile and never starts PostgreSQL.
 * A stopped PostgreSQL 16 profile is copied; the original is never opened.
 */
export async function planLegacyUpgrade(input: { profile: string }): Promise<LegacyUpgradePlan> {
  const blocked = (reason: Extract<LegacyUpgradePlan, { action: "blocked" }>["reason"]) =>
    ({ action: "blocked", reason }) as const;
  const profileKind = await pathKind(input.profile);
  if (profileKind === "missing") return { action: "fresh" };
  if (profileKind === "link") return blocked("symlink");
  if (profileKind !== "directory") return blocked("unreadable");

  let legacy = false;
  for (const name of LEGACY_PROFILE_MARKERS) {
    const kind = await pathKind(path.join(input.profile, name));
    if (kind === "link") return blocked("symlink");
    if (kind === "unreadable") return blocked("unreadable");
    if (kind !== "missing") legacy = true;
  }
  if (!legacy) return { action: "fresh" };

  const dataDir = path.join(input.profile, "pg", "data");
  const kinds = await Promise.all(
    [dataDir, path.join(dataDir, "PG_VERSION"), path.join(dataDir, "postmaster.pid")].map(pathKind),
  );
  if (kinds.includes("link")) return blocked("symlink");
  if (kinds.includes("unreadable")) return blocked("unreadable");
  const [, versionKind, pidKind] = kinds;
  if (pidKind !== "missing") return blocked("live-source");
  if (versionKind !== "file") return blocked("version");
  let version: string;
  try {
    version = (await readFile(path.join(dataDir, "PG_VERSION"), "utf8")).trim();
  } catch {
    return blocked("unreadable");
  }
  return version === NATIVE_POSTGRES_MAJOR ? { action: "copy" } : blocked("version");
}

/** Keys the copied rows were written with, and the owner login of the copied cluster. */
export type LegacyNativeSecrets = { owner: string; auth: string; encryption: string };

export async function readLegacyNativeSecrets(profile: string): Promise<LegacyNativeSecrets> {
  const raw = await readPrivateFile(path.join(profile, "native-stack-env"), 64 * 1024);
  const parsed: unknown = raw === null ? null : JSON.parse(raw);
  const field = (name: string, pattern: RegExp) => {
    const value: unknown = parsed && typeof parsed === "object" ? Reflect.get(parsed, name) : null;
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new Error("Invalid native credentials.");
    }
    return value;
  };
  // initdb wrote the owner login to this file; native-stack-env never held it.
  const owner = (await readPrivateFile(path.join(profile, "pg", ".owner-password"), 256))?.trim();
  if (!owner || !/^[a-f0-9]{32,128}$/.test(owner)) throw new Error("Invalid native credentials.");
  return {
    owner,
    auth: field("BETTER_AUTH_SECRET", /^[a-f0-9]{64}$/),
    encryption: field("ENCRYPTION_KEY", /^[a-f0-9]{64}$/),
  };
}

const RECEIPT = "legacy-upgrade.json";

/** `importing` keeps the copy and retries; `verified` means the current database owns the data. */
export type LegacyUpgradeReceipt = {
  version: 1;
  phase: "importing" | "verified";
  sourceDigest: string;
};

export async function readLegacyUpgradeReceipt(root: string): Promise<LegacyUpgradeReceipt | null> {
  const raw = await readPrivateFile(path.join(root, RECEIPT), 4096);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  const phase = parsed && typeof parsed === "object" ? Reflect.get(parsed, "phase") : null;
  const sourceDigest =
    parsed && typeof parsed === "object" ? Reflect.get(parsed, "sourceDigest") : null;
  if (
    Reflect.get(parsed as object, "version") !== 1 ||
    (phase !== "importing" && phase !== "verified") ||
    typeof sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(sourceDigest)
  ) {
    throw new Error("Unrecognized native data directory.");
  }
  return { version: 1, phase, sourceDigest };
}

export async function writeLegacyUpgradeReceipt(root: string, receipt: LegacyUpgradeReceipt) {
  await writePrivateFile(path.join(root, RECEIPT), JSON.stringify(receipt));
}

/** Folders 0.3.9 wrote under its file directory. */
const LEGACY_FILE_FOLDERS = new Set([
  "artifacts",
  "homes",
  "mcp-packages",
  "pi-sessions",
  "desktop",
  "push-tokens",
]);

/**
 * 0.3.9 never set a file directory, so it wrote `data` under its launch directory.
 * Only a real folder holding nothing but those folders is treated as its files.
 */
export async function legacyFileSources(candidates: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    if ((await pathKind(candidate)) !== "directory") continue;
    const real = await realpath(candidate);
    if (found.includes(real)) continue;
    const names = await readdir(real).catch(() => null);
    if (!names?.length || names.some((name) => !LEGACY_FILE_FOLDERS.has(name))) continue;
    found.push(real);
  }
  return found;
}

/** Copies files and folders only. A retry rewrites every file, so an interrupted copy is never kept. */
export async function copyLegacyFiles(sources: readonly string[], destination: string) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const source of sources) {
    await cp(source, destination, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
      filter: async (file) => (await lstat(file)).isDirectory() || (await lstat(file)).isFile(),
    });
  }
}
