import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Resolve against the caller's directory, the entries against the desktop package.
const outdir = path.resolve(process.argv[2] ?? path.join(desktop, "dist"));

// node-datachannel stays external: its native addon cannot be bundled and must be unpacked.
// ws is bundled; its optional native helpers are required inside try/catch, so leave them out.
// The alias avoids clashing with a `createRequire` import inside the bundled sources.
await build({
  absWorkingDir: desktop,
  entryPoints: {
    "p2p-agent": "p2p/agent-process.ts",
    "p2p-pairing": "p2p/pairing-entry.ts",
  },
  outdir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: {
    js: 'import { createRequire as __p2pCreateRequire } from "node:module"; const require = __p2pCreateRequire(import.meta.url);',
  },
  external: ["node-datachannel", "bufferutil", "utf-8-validate"],
});
