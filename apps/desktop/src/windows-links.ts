import { lstat, mkdir, readFile, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { WINDOWS_LINKS_FILE } from "../scripts/native-bundle-contract.mjs";

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/**
 * Windows installers carry no links, so the native bundle lists its package links and the app
 * recreates them as junctions, which need no administrator rights. Every link and target must
 * stay inside the bundle. A bundle without the list (macOS, Linux) is left as it is.
 */
export async function ensureWindowsLinks(root: string, type: "junction" | "dir" = "junction") {
  let raw: string;
  try {
    raw = await readFile(path.join(root, WINDOWS_LINKS_FILE), "utf8");
  } catch {
    return 0;
  }
  const links: unknown = JSON.parse(raw);
  if (!Array.isArray(links)) throw new Error("Invalid native bundle links.");
  let made = 0;
  for (const entry of links) {
    const link = typeof entry?.link === "string" ? path.resolve(root, entry.link) : "";
    const target = typeof entry?.target === "string" ? path.resolve(root, entry.target) : "";
    if (!link || !target || !inside(root, link) || !inside(root, target) || link === root) {
      throw new Error("Invalid native bundle links.");
    }
    const existing = await lstat(link).catch(() => undefined);
    if (existing) {
      // A junction from an earlier install location points elsewhere; replace only that.
      const current = await realpath(link).catch(() => "");
      if (current === (await realpath(target).catch(() => target))) continue;
      if (!existing.isSymbolicLink()) throw new Error("Invalid native bundle links.");
      // A junction is removed like an empty directory; a POSIX link like a file.
      await (process.platform === "win32" ? rmdir(link) : unlink(link));
    }
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(target, link, type);
    made += 1;
  }
  return made;
}
