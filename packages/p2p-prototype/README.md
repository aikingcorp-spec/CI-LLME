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

## v1 TURN

The gateway mints short-lived TURN credentials (coturn `use-auth-secret` scheme) at `GET /turn-credentials?peer=<id>`. The endpoint is unauthenticated, so keep the gateway on loopback or behind an SSH tunnel until pairing auth exists.

```sh
TURN_URLS='turn:203.0.113.10:3478?transport=udp' TURN_SECRET_FILE=/path/to/turn-secret TURN_TTL_SECONDS=600 \
  NODE_TOKENS=demo:change-me pnpm exec tsx src/bin/gateway.ts
```

Run one peer per process (separate machines for a real NAT test). `--relay` forces relay-only candidates:

```sh
GATEWAY_URL=http://127.0.0.1:8787 pnpm exec tsx src/bin/turn-demo.ts --self peer-b --remote peer-a --relay
GATEWAY_URL=http://127.0.0.1:8787 pnpm exec tsx src/bin/turn-demo.ts --self peer-a --remote peer-b --initiator --relay
```

Each side prints its local candidate counts and `SELECTED local=… remote=…`. The initiator prints the RTT of five pings. Exit is 0 on success and 1 after 30 s. Only the username is printed, never the credential.

`pnpm test` and `pnpm check` run the tests and the type check.

## Not covered

- No pairing crypto or assertions. The node token is a shared placeholder, and `/signal` peers are unauthenticated.
- Without `turn` configured, `iceServers` defaults to `[]`, so only host candidates are used: same machine or same LAN, not across NAT.
- The gateway holds everything in memory and persists nothing. It logs method, path and status only.
- No `ClientTransport` in the web or mobile apps, and no subscribe streaming over the relay.
