import type { LocalHandler } from "../node-agent.js";
import { httpForwardHandler, startNodeAgent } from "../node-agent.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const gatewayUrl = required("GATEWAY_URL");
const nodeId = required("NODE_ID");
const token = required("NODE_TOKEN");

const json = (status: number, value: unknown): Awaited<ReturnType<LocalHandler>> => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const demoHandler: LocalHandler = async (req) => {
  const url = new URL(req.path, "http://node");
  if (req.method === "GET" && url.pathname === "/hello") {
    return json(200, { from: nodeId, pid: process.pid, echo: url.search.slice(1) });
  }
  if (req.method === "POST" && url.pathname === "/echo") {
    return { status: 200, headers: { "content-type": "application/octet-stream" }, body: req.body };
  }
  return json(404, { error: "not found" });
};

const target = process.env.NODE_TARGET;
const agent = startNodeAgent({
  gatewayUrl,
  nodeId,
  token,
  handler: target ? httpForwardHandler(target) : demoHandler,
});
console.log(`node agent ${nodeId} dialing ${gatewayUrl}`);

process.on("SIGINT", () => void agent.close().then(() => process.exit(0)));
