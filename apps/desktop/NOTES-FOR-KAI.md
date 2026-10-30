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

## P2P node (session C2)

`src/p2p-node.ts` starts the `@rakazo/p2p-prototype` node agent after the native stack is ready, and stops it before the database. It is off unless `RAKAZO_P2P_GATEWAY_URL` is set (https, or http on loopback). A node pairs once with `RAKAZO_P2P_PAIR_CODE` (a code from the gateway's `POST /pair/start`); the key then lives in `<userData>/p2p/node-key.json` (mode 0600) with the node id beside it. Only the `health` procedure and `/rpc/*` calls reach the local web origin. There is no settings UI for the gateway URL yet; `P2PNodeOptions.gatewayUrl` is the hook for it.

Needs from the packaging side (none of it is changed here):

- Dependency line for `apps/desktop/package.json` `dependencies`: `"node-datachannel": "0.32.0"` (the version `@rakazo/p2p-prototype` pins). `@rakazo/p2p-prototype` itself is **not** a dependency: the sources are bundled by esbuild through relative paths from `p2p/`. `ws` is bundled, not needed.
- Build step: `node scripts/build-p2p-agent.mjs [outdir]` (default `dist`) writes `p2p-agent.js` (agent, runs in a utility process, `node-datachannel` kept external) and `p2p-pairing.js` (no native code, loaded by main). Both must ship in the app archive's `dist/`. `scripts/build.mjs` is untouched.
- `asarUnpack`: `**/node_modules/node-datachannel/build/Release/*.node`. `nodeDatachannelBinaryDir` checks `<resources>/app.asar.unpacked/node_modules/node-datachannel/build/Release` for a `.node` file and turns P2P off with a Vietnamese and English message when there is none (unit-tested for `win32` with `path.win32`). Not run on Windows.
- Development: `apps/desktop` cannot resolve `node-datachannel`, so build the bundles into `packages/p2p-prototype/dist` and set `RAKAZO_P2P_AGENT_MODULE` to `.../p2p-agent.js` (honoured only when not packaged).

Why a utility process and not the main process: in Electron's main process, libdatachannel rejects every offer ("Invalid media description line") once koffi has been loaded first (the app loads it through `packages/adapters`), and the process hangs or crashes at exit unless `node-datachannel.cleanup()` runs. A crash in main would also leave the database running. The agent process calls `cleanup()` on stop.

Local proof: `RAKAZO_P2P_LOCAL_PROOF=1` (stub API, agent in a Node child) and `RAKAZO_P2P_PROOF_ELECTRON=1` (real app under xvfb) run `src/p2p-local-proof.test.ts`; see the header of that file.
