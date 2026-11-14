/**
 * PostgreSQL 16 server that reads a stopped 0.3.9 profile copy during the upgrade.
 * It never initializes a cluster and never opens the original profile.
 */
export function legacyPostgresBundleFiles(platform = process.platform) {
  return [
    `pg16/bin/postgres${platform === "win32" ? ".exe" : ""}`,
    "pg16/share/postgresql/postgres.bki",
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
    executable("pg_isready"),
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
