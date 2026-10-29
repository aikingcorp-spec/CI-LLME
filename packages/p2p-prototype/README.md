# @rakazo/p2p-prototype

Throwaway prototype for [ADR 0001](../../docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md): a loopback gateway, an outbound node agent, and a WebRTC data channel. It touches no app and no other package.

## Run it

Run `pnpm install` once, then work from this directory. All tokens below are fake placeholders; keep key files outside the repository.

Start the gateway in one terminal:

```sh
USER_TOKENS=demo:change-me pnpm exec tsx src/bin/gateway.ts
```

In a second terminal, request a single-use pairing code (valid for 120 seconds):

```sh
curl -X POST -H 'Authorization: Bearer change-me' http://127.0.0.1:8787/pair/start
```

Use the returned code to pair and start the node agent:

```sh
GATEWAY_URL=http://127.0.0.1:8787 NODE_ID=demo NODE_KEY_FILE=/tmp/p2p-demo-node.json PAIR_CODE=REPLACE_CODE \
  pnpm exec tsx src/bin/node-agent.ts
```

The node saves its Ed25519 key pair, pinned gateway public key, and allowed user in an owner-only (`0600`) file. Subsequent agent starts use `NODE_KEY_FILE` without `PAIR_CODE`. Set `NODE_TARGET=http://127.0.0.1:3100` to forward to a local Rakazo API instead of the demo handler.

The existing HTTP relay also requires the user bearer:

```sh
curl -H 'Authorization: Bearer change-me' 'http://127.0.0.1:8787/nodes/demo/hello?x=1'
curl -H 'Authorization: Bearer change-me' -d hi http://127.0.0.1:8787/nodes/demo/echo
```

Open a data channel between two processes:

```sh
GATEWAY_URL=http://127.0.0.1:8787 USER_TOKEN=change-me pnpm exec tsx src/bin/webrtc-demo.ts
```

This pairs a temporary node, obtains a client assertion, runs both peers, then unpairs the node. It exits 0 once both messages arrive.

## Authentication

`USER_TOKENS` is a comma-separated `user:token` map standing in for gateway login. `POST /sessions` with the user's bearer and `{ "nodeId": "demo", "peerId": "peer-a" }` returns a gateway-signed assertion lasting 60 seconds. Clients use `Authorization: Assertion <token>` for `/signal?peer=peer-a` and `/turn-credentials?peer=peer-a`; the peer id must match. Nodes authenticate signaling and TURN requests with a timestamped Ed25519 proof of their registered identity. Agent WebSockets require a signed hello within 30 seconds of the gateway clock.

`node-auth.ts` verifies assertions against the pinned gateway key and allowed users, then mints local bearers with the same expiry. Its revocation callback lets a channel owner close a live channel on bearer/user revocation or expiry. This is a prototype session store, separate from the product's Better Auth sessions.

`DELETE /nodes/demo` with the owning user's bearer revokes the registry entry and closes its agent and signaling sockets. New assertions and node connections are rejected. Local node session revocation is separate; a direct data channel must use the node's revocation callback.

The registry and pairing codes are in memory. Restarting the gateway loses pairings, even with `GATEWAY_KEY_FILE` set; use a new node id and key file to pair again. `GATEWAY_KEY_FILE` optionally saves/loads the gateway signing key with mode `0600`. The default bind address remains `127.0.0.1`.

## TURN

With coturn's `use-auth-secret` scheme, configure the gateway:

```sh
TURN_URLS='turn:203.0.113.10:3478?transport=udp' TURN_SECRET_FILE=/path/to/turn-secret TURN_TTL_SECONDS=600 \
  USER_TOKENS=demo:change-me pnpm exec tsx src/bin/gateway.ts
```

Pair a node as above. Run the responder with that node's key file, and the client with its user token (separate machines for a real NAT test). `--relay` forces relay candidates:

```sh
GATEWAY_URL=http://127.0.0.1:8787 NODE_KEY_FILE=/tmp/p2p-demo-node.json \
  pnpm exec tsx src/bin/turn-demo.ts --self demo --remote peer-a --relay
GATEWAY_URL=http://127.0.0.1:8787 USER_TOKEN=change-me \
  pnpm exec tsx src/bin/turn-demo.ts --self peer-a --remote demo --initiator --relay
```

Client TURN credentials expire no later than the assertion. The responder authenticates with its node key. Each side prints candidate counts and the selected pair; the client prints five ping RTTs. Credentials and keys are never printed.

Probe an actual TURN Allocate over UDP without WebRTC:

```sh
TURN_HOST=203.0.113.10 TURN_PORT=3478 TURN_SECRET_FILE=/path/to/turn-secret \
  pnpm exec tsx src/bin/turn-allocate-probe.ts --valid
TURN_HOST=203.0.113.10 TURN_SECRET_FILE=/path/to/turn-secret \
  pnpm exec tsx src/bin/turn-allocate-probe.ts --expired-seconds 30
```

The probe handles the 401 realm/nonce challenge and long-term MESSAGE-INTEGRITY. It prints the username, response class, error code/reason or relayed address. Exit 0 means the expected outcome (allocation for `--valid`, refusal for an expired username), 1 an unexpected outcome, and 2 no response or invalid arguments. No secret, password, or integrity key is printed.

## Verification and limits

`pnpm check` and `pnpm test` run the type check and offline tests, including published STUN integrity vectors. No live TURN server is required for the suite.

Without TURN, `iceServers` defaults to `[]`: host candidates work on the same machine or LAN. The demos exercise authenticated signaling; they do not integrate the node bearer into Rakazo RPC or implement the app's `ClientTransport`. There is no subscribe streaming over the HTTP relay. The gateway stores no chat and logs method, path, and status only. Pairing assumes a trusted gateway connection (loopback here; HTTPS/WSS for remote use).
