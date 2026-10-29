# @rakazo/p2p-prototype

Throwaway prototype for [ADR 0001](../../docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md): a hosted gateway, a node agent that only dials out, and a WebRTC data channel signaled through the gateway. It touches no app and no other package.

## Run it

Run `pnpm install` once, then work from this directory.

Relay an HTTP request to a node behind NAT (three terminals):

```sh
NODE_TOKENS=demo:change-me pnpm exec tsx src/bin/gateway.ts
GATEWAY_URL=http://127.0.0.1:8787 NODE_ID=demo NODE_TOKEN=change-me pnpm exec tsx src/bin/node-agent.ts
curl 'http://127.0.0.1:8787/nodes/demo/hello?x=1'
curl -d hi 'http://127.0.0.1:8787/nodes/demo/echo'
```

Set `NODE_TARGET=http://127.0.0.1:3100` on the node agent to forward to a local Rakazo API instead of the demo handler.

Open a data channel between two processes through the gateway's `/signal` socket:

```sh
GATEWAY_URL=http://127.0.0.1:8787 pnpm exec tsx src/bin/webrtc-demo.ts
```

It exits 0 once "ping from a" and "pong from b" have both arrived. `peer a` or `peer b` as arguments runs one side by hand.

`pnpm test` and `pnpm check` run the tests and the type check.

## Not covered

- No pairing crypto or assertions. The node token is a shared placeholder, and `/signal` peers are unauthenticated.
- No TURN or STUN. `iceServers` defaults to `[]`, so only host candidates are used: same machine or same LAN, not across NAT.
- The gateway holds everything in memory and persists nothing. It logs method, path and status only.
- No `ClientTransport` in the web or mobile apps, and no subscribe streaming over the relay.
