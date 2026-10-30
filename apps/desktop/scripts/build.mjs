import { build } from "esbuild";

// Native modules and the bundled Postgres stay on disk (asarUnpack) and load at runtime.
const nativeExternals = ["node-datachannel", "embedded-postgres", "@embedded-postgres/*"];
const requireBanner =
  'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  banner: { js: requireBanner },
  external: ["electron", "electron-updater", "koffi", "@sentry/electron", ...nativeExternals],
});

// Windows and Linux installers run the API and worker without Docker. `--native` (used by
// pack:win and pack:linux) or DESKTOP_NATIVE=1 bundles both into native/server, which
// electron-builder ships as resources/server. Prisma 7 compiles queries in WebAssembly that
// is inlined in the client runtime, so @prisma/client and pg bundle in and no engine files
// ship. Only the native modules above stay external.
if (process.argv.includes("--native") || process.env.DESKTOP_NATIVE === "1") {
  await build({
    entryPoints: { api: "../api/src/index.ts", worker: "../worker/src/index.ts" },
    outdir: "native/server",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    // No "module" condition: resolve dependencies the way Node will.
    conditions: ["node"],
    logLevel: "warning",
    banner: { js: requireBanner },
    external: [...nativeExternals, "pg-native"],
  });
}
