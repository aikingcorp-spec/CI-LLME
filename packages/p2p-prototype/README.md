# @rakazo/p2p-prototype

Throwaway prototype for [ADR 0001](../../docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md): a loopback gateway, an outbound node agent, and a WebRTC data channel. It touches no app and no other package.

## Run it

Run `pnpm install` once, then work from this directory. All tokens below are fake placeholders; keep key files outside the repository.

Start the gateway in one terminal:

```sh
AUTH_BASE_URL=http://127.0.0.1:3100 pnpm exec tsx src/bin/gateway.ts
```

In a second terminal, request a single-use pairing code (valid for 120 seconds):

```sh
curl -X POST -H "Authorization: Bearer $SESSION_TOKEN" http://127.0.0.1:8787/pair/start
```

Use the returned code to pair and start the node agent:

```sh
GATEWAY_URL=http://127.0.0.1:8787 NODE_ID=demo NODE_KEY_FILE=/tmp/p2p-demo-node.json PAIR_CODE=REPLACE_CODE \
  pnpm exec tsx src/bin/node-agent.ts
```

The node saves its Ed25519 key pair, pinned gateway public key, and allowed user in an owner-only (`0600`) file. Subsequent agent starts use `NODE_KEY_FILE` without `PAIR_CODE`. Set `NODE_TARGET=http://127.0.0.1:3100` to forward to a local Rakazo API instead of the demo handler.

The existing HTTP relay also requires the user bearer:

```sh
curl -H "Authorization: Bearer $SESSION_TOKEN" 'http://127.0.0.1:8787/nodes/demo/hello?x=1'
curl -H "Authorization: Bearer $SESSION_TOKEN" -d hi http://127.0.0.1:8787/nodes/demo/echo
```

Open a data channel between two processes:

```sh
GATEWAY_URL=http://127.0.0.1:8787 SESSION_TOKEN="$SESSION_TOKEN" pnpm exec tsx src/bin/webrtc-demo.ts
```

This pairs a temporary node, obtains a client assertion, runs both peers, then unpairs the node. It exits 0 once both messages arrive.

## Sign-in

Sign in to vnbot.run through the existing app. Set `SESSION_TOKEN` to the **signed Better Auth session token returned by sign-in**, not a raw database session token. All client demos send it as `Authorization: Bearer <signed session token>`. For cookie clients, send the complete sign-in Cookie header instead, for example:

```sh
curl -X POST -H "Cookie: $SESSION_COOKIE" http://127.0.0.1:8787/pair/start
```

The gateway requires `AUTH_BASE_URL`, an explicit http(s) URL for the running app API. It calls `GET /api/auth/get-session`, forwarding only the incoming Cookie header verbatim and Bearer Authorization. User identity and node ownership use the verified app user ID; the registry also keeps email for display. No app auth code or database is duplicated here.

Missing or expired sessions return `401 {"code":"NO_SESSION"}`. A session whose email is no longer invited returns `401 {"code":"EMAIL_NOT_INVITED"}`. Auth service failures and timeouts return `502 {"code":"AUTH_UNAVAILABLE"}`. The app separately rejects OTP sign-in for non-invited email with 403; the gateway does not handle OTP sign-in.

Verification caches at most 1,000 SHA-256 credential keys. Positive results last at most 30 seconds and never past session expiry; negative results last five seconds. Invite removal or sign-out can therefore take up to 30 seconds to affect a cached session. Failures are never cached. Auth requests time out after five seconds and reject redirects. Credentials are never logged or forwarded through the HTTP relay.

Run the live smoke test against a running app API and a gateway configured for that same API:

```sh
AUTH_BASE_URL=http://127.0.0.1:3100 GATEWAY_URL=http://127.0.0.1:8787 \
  SESSION_TOKEN="$SESSION_TOKEN" pnpm exec tsx src/bin/login-e2e.ts
```

Optionally set `EXPIRED_SESSION_TOKEN` and `NOT_INVITED_SESSION_TOKEN` to exercise those cases with real signed sessions; unset cases print a skip. The script prints statuses/codes, pairs a temporary node in-process, calls echo over HTTP and a data channel through ClientTransport, then unpairs. It never prints credentials. Offline tests use a local fake auth HTTP server and require no sign-in or hosted service.

## Node authentication

`POST /sessions` with the user's bearer and `{ "nodeId": "demo", "peerId": "peer-a" }` returns a gateway-signed assertion lasting 60 seconds. Clients use `Authorization: Assertion <token>` for `/signal?peer=peer-a` and `/turn-credentials?peer=peer-a`; the peer id must match. Nodes authenticate signaling and TURN requests with a timestamped Ed25519 proof of their registered identity. Agent WebSockets require a signed hello within 30 seconds of the gateway clock.

`node-auth.ts` verifies assertions against the pinned gateway key and allowed users, then mints local bearers with the same expiry. Its revocation callback lets a channel owner close a live channel on bearer/user revocation or expiry. This is a prototype session store, separate from the product's Better Auth sessions.

`DELETE /nodes/demo` with the owning user's bearer revokes the registry entry and closes its agent and signaling sockets. New assertions and node connections are rejected. Local node session revocation is separate; a direct data channel must use the node's revocation callback.

The registry and pairing codes are in memory. Restarting the gateway loses pairings, even with `GATEWAY_KEY_FILE` set; use a new node id and key file to pair again. `GATEWAY_KEY_FILE` optionally saves/loads the gateway signing key with mode `0600`. The default bind address remains `127.0.0.1`.

## TURN

With coturn's `use-auth-secret` scheme, configure the gateway:

```sh
TURN_URLS='turn:203.0.113.10:3478?transport=udp' TURN_SECRET_FILE=/path/to/turn-secret TURN_TTL_SECONDS=600 \
  AUTH_BASE_URL=http://127.0.0.1:3100 pnpm exec tsx src/bin/gateway.ts
```

Pair a node as above. Run the responder with that node's key file, and the client with its signed session token (separate machines for a real NAT test). `--relay` forces relay candidates:

```sh
GATEWAY_URL=http://127.0.0.1:8787 NODE_KEY_FILE=/tmp/p2p-demo-node.json \
  pnpm exec tsx src/bin/turn-demo.ts --self demo --remote peer-a --relay
GATEWAY_URL=http://127.0.0.1:8787 SESSION_TOKEN="$SESSION_TOKEN" \
  pnpm exec tsx src/bin/turn-demo.ts --self peer-a --remote demo --initiator --relay
```

Client TURN credentials expire no later than the assertion. Node TURN credentials are capped at the 60-second session lifetime; both are also capped at the configured TTL. The responder authenticates with its node key. Each side prints candidate counts and the selected pair; the client prints five ping RTTs. Credentials and keys are never printed.

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

Without TURN, `iceServers` defaults to `[]`: host candidates work on the same machine or LAN. The transports implement the ADR seam inside this prototype; the production app transports are not integrated. The gateway verifies sign-in against the existing Better Auth API. HTTP relay subscriptions are buffered. The gateway stores no chat and logs method, path, and status only. Pairing assumes a trusted gateway connection (loopback here; HTTPS/WSS for remote use).

## ClientTransport

Start the gateway and paired node agent using the commands above, then run:

```sh
GATEWAY_URL=http://127.0.0.1:8787 SESSION_TOKEN="$SESSION_TOKEN" NODE_ID=demo \
  pnpm exec tsx src/bin/transport-demo.ts
```

The demo calls `echo` and subscribes to `ticks` through both `HttpClientTransport` and `DataChannelClientTransport`. It prints response status/body, chunk timestamps, and the selected ICE candidate pair. The default node handler emits three `data: tick i\n\n` event-stream chunks. Both paths share the node's handler. `NODE_TARGET` forwards RPC to a local API instead; the demo procedures require the default demo handler.

`HttpClientTransport({ baseUrl, nodeId, sessionToken, fetch? })` POSTs to the authenticated gateway HTTP relay. This v0 relay buffers the entire response: `subscribe` yields one combined chunk after completion, so timestamps do not show individual tick arrival. Abort stops the consumer and sends relay cancellation to the node. True HTTP streaming is a v0 limitation.

`DataChannelClientTransport.connect({ signalUrl, selfId, remoteId, initiator: true, authorization: "Assertion …", assertion, signal? })` uses `connectPeer`. Send only the short-lived gateway assertion through signaling. The data channel exchanges `hello`/`welcome`, then sends the node-issued bearer on every request, chunk, response, and cancellation. The node validates each inbound bearer; local revocation or assertion expiry closes the channel and cancels subscriptions. `close()` releases the peer. `signal` on connection setup cancels connection establishment; each `ClientCall.signal` cancels its request independently.

The node agent receives authenticated signaling on its existing outbound gateway link and multiplexes peers by client id. The gateway carries signaling and the explicit v0 HTTP relay only; it never receives the data-channel bearer. Host ICE candidates suffice for the localhost integration tests; cross-NAT operation needs ICE/TURN configuration as in the TURN demo. No TURN server is required for tests.

## Two simulated machines

`src/bin/two-machine-peer.ts node|client` runs one side as a standalone process: it signals through the gateway, opens a data channel, and exchanges `whoami` requests in both directions (client to node and node to client) plus a heartbeat. Set `ICE_SERVERS` to comma-separated TURN URLs and `ICE_TRANSPORT_POLICY=relay` for relay-only runs. It logs JSON lines. The client re-dials after the channel is lost; `SIGTERM` closes with the `BYE`/`BYE_ACK` handshake. Signaling offers, answers, and candidates carry an attempt id; abandoned attempts send cancellation and stale node offers are discarded.

`scripts/netns-two-machines.sh setup|teardown|status` builds two peer namespaces on one host: `p2pA` at `10.77.0.11` and `p2pB` at `10.77.0.12`, each behind its own router namespace with private `iptables` MASQUERADE. Both routers reach the shared public namespace (`10.77.3.10`) for STUN/TURN and reach the gateway through separate root veths (`10.77.1.1` and `10.77.2.1`). The peers have no direct route to each other. Setup is idempotent and needs passwordless `sudo` plus `iptables`; forwarding and NAT settings are confined to the router namespaces.

`src/two-machine.netns.test.ts` starts the fake auth server and gateway, launches the node in `p2pB` and the client in `p2pA`, and checks both-way requests, the selected ICE pair on `10.77.0.x`, a killed and restarted node, and a clean close started from either side. By default it runs both processes on `127.0.0.1`; set `P2P_NETNS=1` for the namespaces (skipped when `sudo -n ip netns` is unavailable). `P2P_LOG_DIR` saves each process log.

```sh
pnpm exec vitest run --root ../.. packages/p2p-prototype/src/two-machine.netns.test.ts
P2P_NETNS=1 pnpm exec vitest run --root ../.. packages/p2p-prototype/src/two-machine.netns.test.ts
```

## TURN over TCP and TLS

node-datachannel 0.32 (libjuice) accepts `relayType: "TurnTcp" | "TurnTls"` but only gathers UDP relay candidates; the binary logs `TURN transports TCP and TLS are not supported with libjuice` and skips the server. To prove the data channel through a coturn over `turn:...?transport=tcp` and `turns:` (self-signed certificate), the test path swaps in [werift](https://github.com/shinyoshiaki/werift-webrtc) (pure TypeScript, dev dependency). `connectPeer` takes an optional `createPeerConnection`; `src/werift-peer-connection.ts` adapts werift to the callback API it drives. Production code keeps node-datachannel and does not import werift.

`PEER_IMPL=werift` makes `two-machine-peer.ts` use it, and `selected_pair` / `channel_open` events then carry `turnTransport` (`udp`, `tcp` or `tls`, read from werift's TURN client transport object behind the selected local candidate). The netns test adds `P2P_PEER_IMPL=werift`, `P2P_EXPECT_TURN_TRANSPORT=tcp|tls` and `P2P_TURN_TLS_CA_FILE=<PEM of the TURNS certificate>`, which pins that certificate as the only trust anchor (hostname is not checked because the peers reach the server through the forwarder). `scripts/turn-forwarder.py` prints per-port wire counters on `SIGUSR1`; with `P2P_EXPECT_TURN_TRANSPORT` set, the test also asserts that only the expected TCP port saw connections, that no UDP datagram went toward either TURN port, and that every TURN connection was closed afterwards (closing the connection frees the allocation).

```sh
P2P_NETNS=1 P2P_TOPOLOGY=routed P2P_TURN_CREDS_FILE=/path/to/creds P2P_TURN_FORWARD=1 P2P_TURN_PUBLIC_IP=<turn ip> \
  P2P_TURN_TRANSPORTS=TurnTcp P2P_ICE_POLICY=relay P2P_EXPECT_CANDIDATE_TYPE=relay \
  P2P_PEER_IMPL=werift P2P_EXPECT_TURN_TRANSPORT=tcp \
  pnpm exec vitest run --root ../.. packages/p2p-prototype/src/two-machine.netns.test.ts
```

For TLS use `P2P_TURN_TRANSPORTS=TurnTls P2P_EXPECT_TURN_TRANSPORT=tls P2P_TURN_TLS_CA_FILE=...`. Caveat: werift falls back from a failed UDP allocation to TCP on its own, so always give an explicit `tcp`/`tls` transport and check `turnTransport`.
