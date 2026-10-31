const { lstat, readFile, readdir, realpath, symlink } = require("node:fs/promises");
const path = require("node:path");

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function packagePath(root, entry) {
  if (typeof entry !== "string" || !entry || entry.includes("\\") || path.isAbsolute(entry)) {
    throw new Error(`Invalid Postgres symlink path: ${entry}`);
  }
  const resolved = path.resolve(root, entry);
  if (resolved === root || !within(root, resolved)) {
    throw new Error(`Postgres symlink path escapes package: ${entry}`);
  }
  return resolved;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hydratePostgresSymlinks(appOutDir) {
  const scope = path.join(
    appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@embedded-postgres",
  );
  let packages;
  try {
    packages = await readdir(scope, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const pkg of packages) {
    if (!pkg.isDirectory() || pkg.name.startsWith("windows-")) continue;
    const root = path.join(scope, pkg.name);
    const manifest = path.join(root, "native", "pg-symlinks.json");
    let entries;
    try {
      entries = JSON.parse(await readFile(manifest, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!Array.isArray(entries)) throw new Error(`Invalid Postgres symlink manifest: ${manifest}`);
    const realRoot = await realpath(root);

    for (const entry of entries) {
      const source = packagePath(root, entry?.source);
      const target = packagePath(root, entry?.target);
      if (await exists(target)) continue;
      if (!within(realRoot, await realpath(source))) {
        throw new Error(`Postgres symlink source escapes package: ${entry.source}`);
      }
      if (!within(realRoot, await realpath(path.dirname(target)))) {
        throw new Error(`Postgres symlink target escapes package: ${entry.target}`);
      }
      await symlink(path.relative(path.dirname(target), source), target);
    }
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === "win32") return;
  await hydratePostgresSymlinks(context.appOutDir);
};
module.exports.hydratePostgresSymlinks = hydratePostgresSymlinks;
