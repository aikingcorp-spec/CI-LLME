import { build } from "esbuild";

// node-datachannel stays external: its native addon cannot be bundled and must be unpacked.
const outdir = process.argv[2] ?? "dist";

await build({
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
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: ["node-datachannel", "bufferutil", "utf-8-validate"],
});
