/**
 * PostgreSQL 16 server that reads a stopped 0.3.9 profile copy during the upgrade.
 * It never initializes a cluster and never opens the original profile.
 */
export function legacyPostgresBundleFiles(platform = process.platform) {
  return [
    `pg16/bin/postgres${platform === "win32" ? ".exe" : ""}`,
    // The Windows build looks for its data and modules directly in share and lib. A 0.3.9
    // profile names its own timezone and uses PL/pgSQL, so both must be where it looks.
    ...["postgres.bki", "timezonesets/Default", "timezone/Asia/Bangkok"].map(
      (file) => `pg16/share/${platform === "win32" ? "" : "postgresql/"}${file}`,
    ),
    `pg16/lib/${platform === "win32" ? "plpgsql.dll" : `postgresql/plpgsql.${platform === "darwin" ? "dylib" : "so"}`}`,
    // Windows starts the server through pg_ctl, which drops administrator rights.
    ...(platform === "win32" ? ["pg16/bin/pg_ctl.exe"] : []),
  ];
}

/** Files `validateNativeBundle` requires. Postgres 18 is the only current target. */
export function nativeBundleFiles(platform = process.platform) {
  const executable = (name) => `pg/bin/${name}${platform === "win32" ? ".exe" : ""}`;
  const node = platform === "win32" ? "node.exe" : "node";
  return [
    node,
    executable("postgres"),
    executable("initdb"),
    ...(platform === "win32" ? [executable("pg_ctl")] : []),
    "pg/share/postgres.bki",
    ...legacyPostgresBundleFiles(platform),
    "apps/api/dist/index.js",
    "apps/worker/dist/index.js",
    "apps/api/dist/cli/migrate-database.js",
    "apps/api/dist/cli/import-legacy-native.js",
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

/** The 0.3.9 embedded server was PostgreSQL 16. */
export function isLegacyPostgresVersion(text) {
  return /^postgres \(PostgreSQL\) 16\./.test(text);
}

/** Windows bundles list their package links here; the app recreates them as junctions. */
export const WINDOWS_LINKS_FILE = "windows-links.json";
