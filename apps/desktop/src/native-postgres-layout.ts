import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

/** Audited embedded cluster. Fresh installs never open or replace this directory. */
export const NATIVE_POSTGRES_MAJOR = "16";
export const NATIVE_DESKTOP_APP_ID = "run.vnbot.desktop";
export const NATIVE_PROFILE_NAME = "VNBot";
/** Current install directory. Distinct from the audited `pg` profile. */
export const CURRENT_NATIVE_DIRECTORY = "native-040";
export const CURRENT_NATIVE_LAYOUT_ID = "native-040-pg18-v1";
export const CURRENT_NATIVE_POSTGRES_MAJOR = "18";
export const LEGACY_PROFILE_MARKERS = ["pg", "native-stack-env", "native-api-port"] as const;

/** Matches the audited native profile; never derives identity from product metadata. */
export function nativePostgresLayout(input: {
  userDataDir: string;
  binDir: string;
  platform: NodeJS.Platform;
}) {
  const p = input.platform === "win32" ? path.win32 : path.posix;
  const root = p.join(input.userDataDir, "pg");
  const executable = (name: string) =>
    p.join(input.binDir, `${name}${input.platform === "win32" ? ".exe" : ""}`);
  return {
    root,
    dataDir: p.join(root, "data"),
    scratchDir: p.join(root, "data.initializing"),
    ownerPasswordFile: p.join(root, ".owner-password"),
    appPasswordFile: p.join(root, ".app-password"),
    initdb: executable("initdb"),
    postgres: executable("postgres"),
    pgCtl: executable("pg_ctl"),
  };
}

export type NativeProfileInspection =
  | { kind: "fresh" }
  | { kind: "current" }
  | { kind: "legacy"; migration: "copy-only"; open: false }
  | { kind: "blocked"; open: false };

async function pathExists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Reads layout markers only. A PostgreSQL 16 `pg` profile is not opened and is
 * not upgraded in place. Copying it requires a reviewed bundle this tree does not run.
 */
export async function inspectNativeProfile(profile: string): Promise<NativeProfileInspection> {
  let legacy = false;
  for (const name of LEGACY_PROFILE_MARKERS) {
    if (await pathExists(path.join(profile, name))) {
      legacy = true;
      break;
    }
  }
  if (legacy) {
    let version = "";
    try {
      version = (await readFile(path.join(profile, "pg", "data", "PG_VERSION"), "utf8")).trim();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Cannot read the native database version.");
      }
    }
    if (version === NATIVE_POSTGRES_MAJOR) {
      return { kind: "legacy", migration: "copy-only", open: false };
    }
    return { kind: "blocked", open: false };
  }
  const current = path.join(profile, CURRENT_NATIVE_DIRECTORY);
  if (!(await pathExists(current))) return { kind: "fresh" };
  let layout = "";
  try {
    layout = (await readFile(path.join(current, "layout"), "utf8")).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "blocked", open: false };
    }
    throw new Error("Cannot read the native database version.");
  }
  return layout === CURRENT_NATIVE_LAYOUT_ID
    ? { kind: "current" }
    : { kind: "blocked", open: false };
}

/** Only a missing directory is fresh. Partial and incompatible clusters remain untouched. */
export async function checkNativeClusterVersion(dataDir: string): Promise<"new" | "existing"> {
  let version: string;
  try {
    version = await readFile(path.join(dataDir, "PG_VERSION"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      try {
        await lstat(dataDir);
      } catch (directoryError) {
        if (
          directoryError instanceof Error &&
          "code" in directoryError &&
          directoryError.code === "ENOENT"
        )
          return "new";
      }
    }
    throw new Error("Cannot read the native database version.");
  }
  if (version.trim() !== NATIVE_POSTGRES_MAJOR) {
    throw new Error("Native database requires PostgreSQL 16. Upgrade approval is required.");
  }
  return "existing";
}
