import { readFileSync } from "node:fs";
import { startGateway } from "../gateway.js";
import { readKeyFile, writeKeyFile } from "../key-file.js";
import type { KeyPair } from "../pairing.js";
import { generateKeyPair } from "../pairing.js";
import type { TurnConfig } from "../turn-credentials.js";

const tokens = process.env.USER_TOKENS;
if (!tokens) {
  console.error("USER_TOKENS is required, e.g. USER_TOKENS=alice:change-me");
  process.exit(1);
}

const userTokens = new Map<string, string>();
for (const pair of tokens.split(",")) {
  const [user, ...rest] = pair.split(":");
  const token = rest.join(":");
  if (!user || !token) {
    console.error("USER_TOKENS entries must look like user:token");
    process.exit(1);
  }
  userTokens.set(user, token);
}

function readGatewayKey(): KeyPair | undefined {
  const path = process.env.GATEWAY_KEY_FILE;
  if (!path) return undefined;
  const existing = readKeyFile(path);
  if (existing) return existing;
  const created = generateKeyPair();
  writeKeyFile(path, created);
  console.log("created gateway key file");
  return created;
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
  userTokens,
  gatewayKey: readGatewayKey(),
  turn: readTurnConfig(),
});
console.log(`gateway listening at ${gateway.url}`);

process.on("SIGINT", () => void gateway.close().then(() => process.exit(0)));
