# Native desktop resource handoff

Session A3 leaves source changes only. Packaging and dependency manifests are intentionally unchanged.

The native runtime needs these installed resources before a Linux or Windows release can run:

- PostgreSQL **16** binaries and their libraries from the matching `@embedded-postgres/<platform>` package, unpacked outside asar. `RAKAZO_PG_BIN_DIR` or `NativePostgres.binDir` can inject the binary directory without a new dependency. The platform package must resolve from the desktop entry when no directory is injected.
- All unchanged `packages/db/prisma/migrations/*/migration.sql` files at `resources/migrations`.
- Bundled API and worker entries at `resources/server/api/dist/index.js` and `resources/server/worker/dist/index.js`, including their runtime resources and generated Prisma client. Development expects the corresponding `apps/*/dist/index.js` entries.
- The existing `pg` dependency resolvable relative to `resources/server/db/package.json`; the existing `graphile-worker` dependency resolvable relative to `resources/server/adapters/package.json`.
- The shared database role provisioning module and its runtime imports compiled at `resources/server/db/dist/database-access.js`. Development falls back to `packages/db/src/database-access.ts` using Node's built-in TypeScript support. No generated Prisma module is needed by this provisioning module at runtime because its Prisma import is type-only.
- The built web renderer at `resources/web` (already configured).

Migrations run in the Electron main process (`runInProcessMigration` in `native-stack.ts`): the desktop bundle is one ESM file that imports `electron` window APIs, which a utility process cannot load (the first attempt exited with `does not provide an export named 'BrowserWindow'`). No additional desktop build entry or Prisma CLI is needed; a separate migration entry in `scripts/build.mjs` would let it move back into an isolated utility process. Schema files run in separate transactions; original checksums are retained while top-level transaction wrappers are removed and concurrent indexes run synchronously on the local database before clients start. Graphile migrations and shared runtime-role grants finish before API/worker launch.

Linux and Windows choose native by default; macOS retains Docker. The existing runtime override can select Docker explicitly. New local native startup skips the Docker setup screen; existing remote connections keep their setup. Permission settings and host-command guards remain in the existing product code.

`RAKAZO_DESKTOP_SMOKE=1` starts the stack, persists the private stack web URL, checks the API health through the local web origin, stops the stack, and exits with one sanitized result line. A packaged application smoke run still requires the resources above. This session does not establish a successful full Electron smoke run or a Windows binary run.
