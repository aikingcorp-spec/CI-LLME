import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, statfs } from "node:fs/promises";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

type SnapshotEntry =
  | { name: string; kind: "directory" }
  | { name: string; kind: "file"; size: number; sha256: string };
type SnapshotManifest = { version: 1; phase: "copying" | "verified"; sourceDigest: string };
export type LegacyProfileSnapshot = { directory: string; sourceDigest: string };
const RECEIPT = ".vnbot-profile-snapshot.json";

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function present(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function assertClosed(profile: string) {
  if (await present(path.join(profile, "pg", "data", "postmaster.pid")))
    throw new Error("Legacy database must be stopped before copying.");
  if ((await readFile(path.join(profile, "pg", "data", "PG_VERSION"), "utf8")).trim() !== "16")
    throw new Error("Expected a PostgreSQL 16 profile.");
}
/** `names` limits the top level to those entries; a snapshot lists everything except its receipt. */
async function inventory(root: string, names?: readonly string[]): Promise<SnapshotEntry[]> {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink())
    throw new Error("Invalid legacy snapshot directory.");
  const entries: SnapshotEntry[] = [];
  async function walk(relative: string) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (!relative && (names ? !names.includes(name) : name === RECEIPT)) continue;
      const key = path.join(relative, name);
      const file = path.join(root, key);
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("Legacy snapshot cannot contain symbolic links.");
      if (info.isDirectory()) {
        entries.push({ name: key, kind: "directory" });
        await walk(key);
      } else if (info.isFile()) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        entries.push({ name: key, kind: "file", size: info.size, sha256: hash.digest("hex") });
      } else throw new Error("Legacy snapshot contains a special file.");
    }
  }
  await walk("");
  return entries;
}
function digest(entries: SnapshotEntry[]) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
async function manifest(directory: string): Promise<SnapshotManifest> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Invalid legacy snapshot directory.");
  const raw = await readPrivateFile(path.join(directory, RECEIPT), 4096);
  if (!raw) throw new Error("Unrecognized legacy snapshot; existing files were kept.");
  const parsed: unknown = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("phase" in parsed) ||
    (parsed.phase !== "copying" && parsed.phase !== "verified") ||
    !("sourceDigest" in parsed) ||
    typeof parsed.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sourceDigest)
  )
    throw new Error("Invalid legacy snapshot receipt.");
  return { version: 1, phase: parsed.phase, sourceDigest: parsed.sourceDigest };
}

/**
 * Copies the named top-level entries of a stopped profile. The original and any
 * unrecognized destination are never written.
 */
export async function snapshotLegacyProfile(input: {
  profile: string;
  entries: readonly string[];
  destination: string;
}): Promise<LegacyProfileSnapshot> {
  const sourceInfo = await lstat(input.profile);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error("Invalid legacy source profile.");
  const profile = await realpath(input.profile);
  const destination = path.resolve(input.destination);
  const parent = await realpath(path.dirname(destination));
  if (parent !== path.dirname(destination))
    throw new Error("Snapshot parent cannot contain symbolic links.");
  const relative = path.relative(profile, destination);
  const top = relative.split(path.sep)[0] ?? "";
  if (
    !relative ||
    input.entries.some((name) => !name || name.includes("/") || name.includes("\\")) ||
    (!top.startsWith("..") && !path.isAbsolute(relative) && input.entries.includes(top))
  )
    throw new Error("Snapshot must be outside the copied entries.");
  await assertClosed(profile);
  const entries = await inventory(profile, input.entries);
  const sourceDigest = digest(entries);
  if (await present(destination)) {
    const saved = await manifest(destination);
    if (
      saved.phase !== "verified" ||
      saved.sourceDigest !== sourceDigest ||
      digest(await inventory(destination)) !== sourceDigest
    )
      throw new Error("Legacy snapshot changed; existing files were kept.");
    return { directory: destination, sourceDigest };
  }
  const staging = `${destination}.copying`;
  if (await present(staging)) {
    const saved = await manifest(staging);
    if (saved.sourceDigest !== sourceDigest)
      throw new Error("Interrupted snapshot belongs to a different source.");
    const expected = new Map(entries.map((entry) => [entry.name, entry.kind]));
    for (const entry of await inventory(staging))
      if (expected.get(entry.name) !== entry.kind)
        throw new Error("Unrecognized files in interrupted snapshot; files were kept.");
  } else {
    const space = await statfs(parent, { bigint: true });
    const size = entries.reduce(
      (total, entry) => total + (entry.kind === "file" ? BigInt(entry.size) : 0n),
      0n,
    );
    if (space.bavail * space.bsize < size)
      throw new Error("Not enough disk space for a legacy profile copy.");
    await mkdir(staging, { mode: 0o700 });
    await writePrivateFile(
      path.join(staging, RECEIPT),
      JSON.stringify({ version: 1, phase: "copying", sourceDigest } satisfies SnapshotManifest),
    );
  }
  for (const entry of entries) {
    const target = path.join(staging, entry.name);
    if (entry.kind === "directory") await mkdir(target, { recursive: true, mode: 0o700 });
    else await cp(path.join(profile, entry.name), target, { force: true, dereference: false });
  }
  await assertClosed(profile);
  if (
    digest(await inventory(profile, input.entries)) !== sourceDigest ||
    digest(await inventory(staging)) !== sourceDigest
  )
    throw new Error("Legacy profile changed while copying; source was kept.");
  await writePrivateFile(
    path.join(staging, RECEIPT),
    JSON.stringify({ version: 1, phase: "verified", sourceDigest } satisfies SnapshotManifest),
  );
  await rename(staging, destination);
  return { directory: destination, sourceDigest };
}
