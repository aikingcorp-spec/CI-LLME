/*
 * Local end-to-end harness for VNB-022: serves the real POST /api/auth/p2p-token route with a
 * fixed signed-in user, so the gateway smoke (TOKEN_URL=...) can pair and signal with tokens
 * this server minted. Development only: the session is fake.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { mountP2pTokenRoute, p2pTokenConfigFromEnv } from "../src/p2p-token.js";

if (process.env.NODE_ENV === "production") throw new Error("p2p-token-dev is for local runs only");
const config = p2pTokenConfigFromEnv(process.env, "https://app.vnbot.run");
if (config === undefined) throw new Error("set P2P_TOKEN_PRIVATE_KEY and P2P_TOKEN_KID");
const app = new Hono();
mountP2pTokenRoute(app, {
  config,
  trustedOrigin: (origin) => origin === "https://app.vnbot.run",
  sessionUser: async () => ({ id: "e2e-user", email: "e2e@local" }),
});
const port = Number(process.env.PORT ?? 8799);
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  process.stdout.write(`p2p-token-dev on :${port}\n`),
);
