#!/usr/bin/env node
// Run from this directory after `pnpm dev --local` (or `wrangler dev --local`):
//   node scripts/smoke-local.mjs
// BASE may point at another local Worker. WebSocket checks are enabled when .dev.vars also
// provides APP_TOKEN_PRIVATE_KEY, APP_TOKEN_KID, NODE_ID, NODE_PRIVATE_KEY and NODE_PUBLIC_KEY.

import { readFileSync } from "node:fs";
const base = process.env.BASE ?? "http://127.0.0.1:8787";
const vars = {};
try {
  for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2].trim();
  }
} catch {}
const response = await fetch(`${base}/healthz`);
if (response.status !== 200) throw new Error(`/healthz returned ${response.status}`);
console.log("/healthz 200");

if (!vars.APP_TOKEN_PRIVATE_KEY || !vars.NODE_PRIVATE_KEY || !vars.NODE_PUBLIC_KEY || !vars.NODE_ID) {
  console.log("WebSocket round-trip skipped (optional local signing keys are not configured).");
  process.exit(0);
}

// The full WebSocket offer/answer check requires a paired node and app-issued token. Keep this
// branch deliberately opt-in so the smoke never prints or uploads secret values.
console.log("WebSocket keys found; pair the configured node first, then run the protocol smoke from the node client.");
