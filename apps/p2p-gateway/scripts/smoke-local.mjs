#!/usr/bin/env node
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const base = process.env.BASE ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");
const vars = {};
try {
  for (const line of readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split(
    /\r?\n/,
  )) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2].trim();
  }
} catch {}
const b64 = (v) => Buffer.from(v).toString("base64url");
const key = (d, x) =>
  createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d, x }, format: "jwk" });
const tokenUrl = process.env.TOKEN_URL; // VNB-022: fetch app tokens from the auth server instead of signing them here.
if (
  (!tokenUrl && (!vars.APP_TOKEN_PRIVATE_KEY || !vars.APP_TOKEN_PUBLIC_KEY)) ||
  !vars.NODE_PRIVATE_KEY ||
  !vars.NODE_PUBLIC_KEY
)
  throw new Error("local signing keys are required");
const nodeId = vars.NODE_ID ?? `smoke-${Date.now().toString(36)}`;
const privateKey = key(vars.NODE_PRIVATE_KEY, vars.NODE_PUBLIC_KEY);
const appKey = tokenUrl ? undefined : key(vars.APP_TOKEN_PRIVATE_KEY, vars.APP_TOKEN_PUBLIC_KEY);
const fetchToken = async () => {
  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.TOKEN_ORIGIN ?? "https://app.vnbot.run",
    },
    body: JSON.stringify({ scope: ["pair", "session", "nodes"] }),
  });
  if (r.status !== 200) throw new Error(`token endpoint ${r.status}`);
  return (await r.json()).token;
};
const token = () => {
  if (tokenUrl) return fetchToken();
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: "EdDSA", typ: "vnbot-p2p+jwt", kid: vars.APP_TOKEN_KID }));
  const p = b64(
    JSON.stringify({
      iss: vars.APP_TOKEN_ISSUER ?? "https://app.vnbot.run",
      aud: vars.APP_TOKEN_AUDIENCE ?? "p2p.vnbot.run",
      sub: "smoke-user",
      email: "smoke@local",
      iat: now,
      nbf: now,
      exp: now + 300,
      jti: b64(randomBytes(16)),
      scope: ["pair", "session", "nodes", "turn"],
    }),
  );
  return `${h}.${p}.${b64(sign(null, Buffer.from(`${h}.${p}`), appKey))}`;
};
const req = async (method, path, body, auth = true) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${await token()}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.text() };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = (path, protocols) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${path}`, protocols);
    const messages = [];
    ws.onmessage = (e) => messages.push(String(e.data));
    ws.onerror = () => reject(new Error("websocket error"));
    ws.onopen = () => resolve({ ws, messages });
  });
const health = await req("GET", "/healthz", undefined, false);
if (health.status !== 200) throw new Error("health check failed");
console.log("healthz 200");
const pair = await req("POST", "/pair/start");
if (pair.status !== 200) throw new Error("pair start failed");
const { code } = JSON.parse(pair.body);
const nodeIdMsg = `pair|${code}|${nodeId}`;
const pairSig = b64(sign(null, Buffer.from(nodeIdMsg), privateKey));
const complete = await fetch(`${base}/pair/complete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    code,
    nodeId,
    nodePublicKey: vars.NODE_PUBLIC_KEY,
    sig: pairSig,
    kind: "linux",
  }),
});
if (complete.status !== 200 && complete.status !== 409) throw new Error("pair complete failed");
const ts = Date.now();
const agent = await open(`/agent?node=${encodeURIComponent(nodeId)}`);
agent.ws.send(
  JSON.stringify({
    kind: "hello",
    nodeId,
    ts,
    sig: b64(sign(null, Buffer.from(`agent|${nodeId}|${ts}`), privateKey)),
  }),
);
await wait(150);
if (!agent.messages.some((m) => m.includes('"welcome"')))
  throw new Error("agent did not receive welcome");
const session = await req("POST", "/sessions", { nodeId, peerId: "smoke-client" });
if (session.status !== 200) throw new Error("session failed");
const assertion = JSON.parse(session.body).assertion;
const client = await open(`/signal?peer=smoke-client`, ["vnbot.v1", `assertion.${assertion}`]);
const canary = `smoke-canary-${Date.now().toString(36)}`;
client.ws.send(
  JSON.stringify({
    kind: "signal",
    from: "smoke-client",
    to: nodeId,
    payload: { type: "offer", sdp: canary },
  }),
);
await wait(150);
if (!agent.messages.some((m) => m.includes(canary))) throw new Error("offer was not relayed");
agent.ws.send(
  JSON.stringify({
    kind: "signal",
    from: nodeId,
    to: "smoke-client",
    payload: { type: "answer", sdp: canary },
  }),
);
await wait(150);
if (!client.messages.some((m) => m.includes(canary))) throw new Error("answer was not relayed");
client.ws.send(
  JSON.stringify({
    kind: "signal",
    from: "smoke-client",
    to: "other-client",
    payload: { type: "offer", sdp: "forbidden" },
  }),
);
await wait(100);
if (client.ws.readyState === WebSocket.OPEN)
  throw new Error("client-to-client target was accepted");
agent.ws.close();
client.ws.close();
console.log(
  "WebSocket offer/answer round-trip PASS; client-to-client target rejected; clean close",
);
