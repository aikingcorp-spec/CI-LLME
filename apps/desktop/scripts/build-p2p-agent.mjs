import { build } from "esbuild";

// node-datachannel stays external: its native addon cannot be bundled and must be unpacked.
const outfile = process.argv[2] ?? "dist/p2p-agent.js";

await build({
  entryPoints: ["p2p/agent-entry.ts"],
  outfile,
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
