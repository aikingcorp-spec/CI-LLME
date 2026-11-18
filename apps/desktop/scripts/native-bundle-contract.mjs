/** MSVC C/C++ runtime DLLs required by @embedded-postgres/windows-x64 on clean Windows installs. */
export const WINDOWS_MSVC_RUNTIME_DLLS = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];

/** Files `validateNativeBundle` requires. Postgres 18 is the only current target. */
export function nativeBundleFiles(platform = process.platform) {
  const executable = (name) => `pg/bin/${name}${platform === "win32" ? ".exe" : ""}`;
  const node = platform === "win32" ? "node.exe" : "node";
  return [
    node,
    executable("postgres"),
    executable("initdb"),
    ...(platform === "win32"
      ? [
          executable("pg_ctl"),
          ...WINDOWS_MSVC_RUNTIME_DLLS.map((name) => `pg/bin/${name}`),
        ]
      : []),
    "pg/share/postgres.bki",
    "apps/api/dist/index.js",
    "apps/worker/dist/index.js",
    "apps/api/dist/cli/migrate-database.js",
    "apps/web/dist/index.html",
    "packages/db/prisma/schema.prisma",
    "packages/db/prisma.config.ts",
  ];
}

export function nativeBundleManifest(input) {
  return {
    version: 1,
    platform: input.platform,
    arch: input.arch,
    postgresMajor: 18,
    files: Object.fromEntries(nativeBundleFiles(input.platform).map((file) => [file, true])),
  };
}

/** Same probe the native boot accepts from `postgres --version`. */
export function isNativePostgresVersion(text) {
  return /^postgres \(PostgreSQL\) 18\./.test(text);
}

/** Windows bundles list their package links here; the app recreates them as junctions. */
export const WINDOWS_LINKS_FILE = "windows-links.json";
