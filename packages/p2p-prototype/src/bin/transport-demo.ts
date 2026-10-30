import { randomUUID } from "node:crypto";
import { cleanup } from "node-datachannel";
import type { ClientCall, ClientTransport } from "../client-transport.js";
import { DataChannelClientTransport } from "../client-transport.js";
import { openSession } from "../gateway-client.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const baseUrl = required("GATEWAY_URL");
const sessionToken = required("SESSION_TOKEN");
const nodeId = required("NODE_ID");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error("demo timed out")), 20_000);
let channel: DataChannelClientTransport | undefined;
const text = new TextDecoder();
const request = (procedure: string, body: string): ClientCall => ({
  procedure,
  body: new TextEncoder().encode(body),
  headers: { "content-type": "application/json" },
  signal: controller.signal,
});
async function run(name: string, transport: ClientTransport): Promise<void> {
  const result = await transport.call(request("echo", JSON.stringify({ hello: name })));
  console.log(`${name} call status=${result.status} body=${text.decode(result.body)}`);
  for await (const chunk of transport.subscribe(
    request("ticks", JSON.stringify({ count: 3, intervalMs: 100 })),
  )) {
    console.log(`${name} chunk ${new Date().toISOString()} ${JSON.stringify(text.decode(chunk))}`);
  }
}
try {
  const peerId = randomUUID();
  const { assertion } = await openSession(baseUrl, sessionToken, nodeId, peerId);
  channel = await DataChannelClientTransport.connect({
    signalUrl: `${baseUrl}/signal`,
    selfId: peerId,
    remoteId: nodeId,
    initiator: true,
    authorization: `Assertion ${assertion}`,
    assertion,
    signal: controller.signal,
  });
  console.log("selected ICE candidate pair", channel.selectedPair());
  await run("data-channel", channel);
} finally {
  clearTimeout(timeout);
  channel?.close();
  cleanup();
}
