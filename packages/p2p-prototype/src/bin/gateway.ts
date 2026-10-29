import { readFileSync } from "node:fs";
import { startGateway } from "../gateway.js";
import type { TurnConfig } from "../turn-credentials.js";

const tokens = process.env.NODE_TOKENS;
if (!tokens) {
  console.error("NODE_TOKENS is required, e.g. NODE_TOKENS=demo:change-me");
  process.exit(1);
}

const nodeTokens = new Map<string, string>();
for (const pair of tokens.split(",")) {
  const [id, token] = pair.split(":");
  if (!id || !token) {
    console.error("NODE_TOKENS entries must look like nodeId:token");
    process.exit(1);
  }
  nodeTokens.set(id, token);
}

function readTurnConfig(): TurnConfig | undefined {
  const urls = process.env.TURN_URLS;
  const secretFile = process.env.TURN_SECRET_FILE;
  if (!urls && !secretFile) return undefined;
  if (!urls || !secretFile) {
    console.error("TURN_URLS and TURN_SECRET_FILE must be set together");
    process.exit(1);
  }
  const ttlSeconds = Number(process.env.TURN_TTL_SECONDS ?? 600);
  const config = {
    secret: readFileSync(secretFile, "utf8").trim(),
    urls: urls.split(",").map((u) => u.trim()),
    ttlSeconds,
  };
  if (!config.secret) {
    console.error("TURN_SECRET_FILE is empty");
    process.exit(1);
  }
  console.log(`turn credentials enabled, ttl=${ttlSeconds}, urls=${config.urls.join(",")}`);
  return config;
}

const gateway = await startGateway({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST,
  nodeTokens,
  turn: readTurnConfig(),
});
console.log(`gateway listening at ${gateway.url}`);

process.on("SIGINT", () => void gateway.close().then(() => process.exit(0)));
