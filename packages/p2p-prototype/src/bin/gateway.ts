import { startGateway } from "../gateway.js";

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

const gateway = await startGateway({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST,
  nodeTokens,
});
console.log(`gateway listening at ${gateway.url}`);

process.on("SIGINT", () => void gateway.close().then(() => process.exit(0)));
