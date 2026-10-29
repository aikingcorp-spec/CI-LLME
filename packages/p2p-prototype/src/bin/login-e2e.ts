import { randomUUID } from "node:crypto";
import { cleanup } from "node-datachannel";
import type { ClientTransport } from "../client-transport.js";
import { DataChannelClientTransport, HttpClientTransport } from "../client-transport.js";
import { completePairing, openSession, unpairNode } from "../gateway-client.js";
import type { NodeAgent } from "../node-agent.js";
import { startNodeAgent } from "../node-agent.js";
import { channelHttpHandler, demoHandler } from "../node-channel-server.js";
import { generateKeyPair } from "../pairing.js";
import { createHttpSessionVerifier } from "../session-verifier.js";
import { waitFor } from "../test-util.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const authBaseUrl = required("AUTH_BASE_URL");
const gatewayUrl = required("GATEWAY_URL").replace(/\/$/, "");
const sessionToken = required("SESSION_TOKEN");
const signal = AbortSignal.timeout(30_000);
let agent: NodeAgent | undefined;
let channel: DataChannelClientTransport | undefined;
let paired = false;
const nodeId = `login-${randomUUID()}`;
async function pairStart(
  label: string,
  token: string | undefined,
  expectedStatus: number,
  expectedCode?: string,
) {
  const res = await fetch(`${gatewayUrl}/pair/start`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  const body = (await res.json()) as { code?: string };
  console.log(`${label}: status=${res.status}${expectedCode ? ` code=${body.code}` : ""}`);
  if (res.status !== expectedStatus || (expectedCode && body.code !== expectedCode))
    throw new Error(`${label} returned an unexpected result`);
  return body;
}
async function call(label: string, transport: ClientTransport) {
  const response = await transport.call({
    procedure: "echo",
    headers: {},
    body: new TextEncoder().encode("login-e2e"),
    signal,
  });
  console.log(`${label}: status=${response.status}`);
  if (response.status !== 200 || new TextDecoder().decode(response.body) !== "login-e2e")
    throw new Error(`${label} failed`);
}
try {
  await pairStart("no session", undefined, 401, "NO_SESSION");
  for (const [label, env, code] of [
    ["expired", "EXPIRED_SESSION_TOKEN", "NO_SESSION"],
    ["not-invited", "NOT_INVITED_SESSION_TOKEN", "EMAIL_NOT_INVITED"],
  ]) {
    const token = process.env[env ?? ""];
    if (token) await pairStart(label ?? "", token, 401, code);
    else console.log(`${label}: skipped (${env} unset)`);
  }
  const identity = await createHttpSessionVerifier({ authBaseUrl }).verify({
    authorization: `Bearer ${sessionToken}`,
  });
  if (!identity.ok) throw new Error(`app session verification failed: ${identity.code}`);
  const { code } = await pairStart("valid pair/start", sessionToken, 200);
  if (!code) throw new Error("pair/start missing code");
  const keyPair = generateKeyPair();
  const pairing = await completePairing(gatewayUrl, code, nodeId, keyPair);
  paired = true;
  if (pairing.user !== identity.user.id) throw new Error("gateway and app user mismatch");
  const handler = demoHandler();
  agent = startNodeAgent({
    gatewayUrl,
    nodeId,
    keyPair,
    handler: channelHttpHandler(handler),
    channel: {
      gatewayPublicKey: pairing.gatewayPublicKey,
      allowedUsers: [identity.user.id],
      handler,
    },
  });
  await waitFor(() => agent?.connected() === true);
  await call("HTTP relay", new HttpClientTransport({ baseUrl: gatewayUrl, nodeId, sessionToken }));
  const peerId = randomUUID();
  const { assertion } = await openSession(gatewayUrl, sessionToken, nodeId, peerId);
  channel = await DataChannelClientTransport.connect({
    signalUrl: `${gatewayUrl}/signal`,
    selfId: peerId,
    remoteId: nodeId,
    initiator: true,
    authorization: `Assertion ${assertion}`,
    assertion,
    signal,
  });
  await call("data channel", channel);
} catch {
  console.error("login-e2e failed; check the printed statuses and environment configuration");
  process.exitCode = 1;
} finally {
  channel?.close();
  await agent?.close();
  if (paired) {
    try {
      await unpairNode(gatewayUrl, sessionToken, nodeId);
    } catch {
      console.error("temporary node cleanup failed");
      process.exitCode = 1;
    }
  }
  cleanup();
}
