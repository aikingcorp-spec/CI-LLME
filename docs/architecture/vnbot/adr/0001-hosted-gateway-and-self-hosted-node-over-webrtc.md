# ADR 0001: Hosted gateway and a self-hosted node over WebRTC

Status: **Proposed**

Date: 2026-10-28

This decision sits in the VNBot layer. It does not change `docs/architecture/rakazo-baseline/`. Nothing in it is implemented. An earlier draft of this number treated WebRTC as a way to view the bot's desktop. That was the wrong problem. The in-node screen relay stays as the baseline describes it and is not this decision.

## Problem

A customer runs the whole Rakazo stack on a machine they own: a Mac mini at home, an office PC, or their own VPS. That machine is a **node**. Chat, runs, files, and sandboxes stay there.

People still open a browser or the phone app at **vnbot.run**, which we host. They sign in with email, see the nodes they paired, and drive a node that is behind NAT and has no inbound ports. vnbot.run must not store chat.

The client at vnbot.run therefore cannot keep calling "whatever origin served this page." The page origin is the gateway. The API is the node. The path between them should be a WebRTC data channel when possible, with TURN only when the peers cannot connect directly.

## Components

```text
phone or browser at vnbot.run
        |  sign-in, node list, signaling (HTTPS, same origin as the page)
        v
vnbot.run gateway
        |  outbound only, from the node
        ^
node agent  ---- same machine ----  Rakazo node
                                      api + worker + Postgres + sandboxes
```

**Gateway (vnbot.run).** Hosted by us. It does four jobs:

- Account sign-in for the gateway (email). This is not a copy of the node's chat database.
- A node registry: which gateway user paired which node, and that node's public key.
- Signaling: exchange SDP and ICE candidates for a session the registry allows.
- TURN (and STUN) credentials for when a direct path fails. TURN relays ciphertext. It does not terminate the peer connection and it does not see chat plaintext.

The gateway does not run Postgres for bots, threads, runs, or vault rows. It does not proxy `/rpc` as a store-and-forward of chat.

**Node.** One self-hosted Rakazo deployment: API, worker, database, and sandboxes, as the baseline map describes. Plus a **node agent** on that same machine. The agent keeps an outbound connection to the gateway's signaling endpoint so the node never needs a listening public port. The agent carries pairing and signaling only. Chat bytes go on the WebRTC data channel between the client and the node, or through TURN as encrypted relay, not through the agent's control messages and not through the gateway's database.

The node agent does not exist in this tree. It would be a new process or a composition-root task next to `apps/api/src/index.ts`, not a change to the baseline documents.

## Trust

1. The human signs in on vnbot.run. That session is a gateway session. It authorizes registry and signaling calls only.
2. At first start the node generates a key pair. The public key is the node's identity. The private key stays on the node.
3. Pairing: the signed-in user starts a pairing on the gateway and gets a short-lived code. The node agent sends that code and the node public key out to the gateway. The gateway stores `(gatewayUser, nodeId, nodePublicKey)` and the node stores the gateway's signing key plus which gateway user is allowed to act as which local user. Chat rows are not uploaded.
4. Opening a remote session: the client asks the gateway to signal node N. The gateway checks the registry, then gives the client a short-lived assertion (gateway signature, node id, gateway user, expiry). The assertion may travel in signaling. A long-lived node session token must not.
5. The node checks the assertion with the gateway key it pinned at pairing, checks the user binding, and only then treats the data channel as that local user. The node mints its own bearer for the channel (the same kind of bearer mobile already sends). That bearer is written on the data channel after the peer connection exists, so the gateway cannot read it.
6. Revocation is the registry plus the node. Unpairing or signing out at the gateway stops new assertions. The node drops a live channel when the assertion expires or the local session is revoked. TURN credentials expire with the assertion.

No inbound port on the node is required for this path. The agent's connection is outbound. ICE may still use the node's public mapping as a candidate, but the customer does not configure a port forward.

Local use does not go through the gateway. On the machine itself, or on the same LAN, a client may still talk HTTPS to the node directly (see phases).

## What assumes same-origin HTTP today

There is no `RTCPeerConnection` in this tree. Clients reach the API with `fetch` to an HTTP origin.

### Web app: the page origin is the API origin

The browser client never names a server. `RPCLink` in `apps/web/src/lib/rpc.ts` sets `url` to `${window.location.origin}/rpc` and `fetch` with `credentials: "include"`. A 401 calls `authClient.$store.notify("$sessionSignal")` on that same client. `threads/subscribe` is not a separate socket. It is an oRPC call on that link (`packages/contracts/src/rpc.ts`, `threads.subscribe` with `eventIterator`). The procedure returns a stream; the cookie goes with it.

`createAuthClient` in `apps/web/src/lib/auth.ts` sets no `baseURL`. The Better Auth browser client therefore uses this page's origin and the default `/api/auth` path. These calls are also relative fetches, not the oRPC client:

| Call | File |
| --- | --- |
| `/api/auth/account-security` and `/api/auth${path}` | `apps/web/src/lib/account-security.ts` |
| `/api/auth/capabilities` | `apps/web/src/lib/auth-capabilities.ts` |
| `/api/voice/speak` | `apps/web/src/lib/tts.ts` |
| `/api/voice/transcribe` | `apps/web/src/lib/dictation.ts` |

URLs built from `window.location.origin` would point at the gateway if the page is vnbot.run, which is wrong for node routes:

- OAuth return: `apps/web/src/lib/mcp-connect.ts` (`/mcp/oauth/callback`)
- SSO return checks `target.origin !== window.location.origin`: `apps/web/src/lib/sso-flow.ts`
- Webhook display URLs: `apps/web/src/pages/shell/use-routine-editor.ts` (`/api/v1/bots/.../webhook` and `.../github`)

Dev and the Compose `web` service make the assumption true by proxying. `apps/web/vite.config.ts` proxies `/api`, `/rpc`, and `/.well-known/*` to `API_PROXY_TARGET` (default `http://127.0.0.1:3100`). The service worker refuses to intercept those prefixes on its own origin (`BYPASS_PREFIXES` in `apps/web/src/pwa/service-worker.ts`). Content Security Policy `connect-src` is `'self'` unless extended (`packages/contracts/src/content-security-policy.ts`). `/build-id` in `apps/web/src/lib/client-update.ts` is the static host, not the node.

### Desktop: the loaded window is one server

Electron hosts that same web bundle. `apps/desktop/src/renderer-assets.ts` serves local files and passes `/api`, `/rpc`, and `/novnc` through to the window's origin (`PASSTHROUGH_PATHS`). Setup stores one base URL (`normalizeServerUrl` in `apps/desktop/src/setup-config.ts`). `RAKAZO_CLOUD_URL` is a single hosted origin (`https://app.rakazo.com`), not a list of customer nodes. A remote VNBot user is not "open the node URL in Electron" unless they have a tunnel. The Mac mini that *is* the node can keep running the local stack.

### Mobile: a base URL, still HTTP

The phone is already not same-origin. `API_BASE_STORAGE_KEY` (`apps/mobile/lib/server-config.ts`) is one `http(s)` origin. `normalizeApiBase` in `apps/mobile/lib/endpoint.ts` rejects anything that is not `http:` or `https:`, and `probeApiBase` POSTs `${url}/rpc/health`.

`rpc` in `apps/mobile/lib/api.ts` POSTs `${apiBase}/rpc/${proc}` with `authorization: Bearer` from `loadSessionToken` (`apps/mobile/lib/session.ts`, SecureStore key `rakazo.session_token`) and `origin: rakazo://`. `subscribeThread` in the same file POSTs `/rpc/threads/subscribe` with `accept: text/event-stream` and reads the body. It is a long HTTP response, not a WebSocket. Passkeys and SSO concatenate the same base with `/api/auth/...` (`apps/mobile/lib/passkey.ts`, `apps/mobile/lib/sso.ts`).

So mobile can already aim at a tunnel URL (v0). It cannot aim at a data channel without a new transport. The saved value is a single origin, not a gateway user with many nodes.

### Server entry points that are HTTP

`apps/api/src/app.ts` mounts the product on HTTP:

- CORS allows `webOrigin`, `apiUrl`, `authUrl`, and `rakazo://` (`isTrustedOrigin`), with `credentials: true`. A page on vnbot.run is not trusted by a node unless that node's env lists it. Listing the gateway as `webOrigin` would also make the node accept credentialed browser calls from that origin, which is the opposite of "chat does not go to the gateway."
- `GET`/`POST` `/api/auth/*` calls `auth.handler` (`createAuth` in `packages/auth/src/index.ts`).
- `/rpc/*` runs `RPCHandler` after `auth.api.getSession`. The `signedBearer` plugin turns `Authorization: Bearer` into the session cookie lookup. That is the hook a data-channel transport can reuse. Cookie `credentials: "include"` is the web hook, and it does not cross to another origin.
- Voice HTTP: `mountVoiceHttpRoutes` posts `/api/voice/speak` and `/api/voice/transcribe` (`apps/api/src/voice.ts`).
- `threads.subscribe` and `boards.subscribe` are procedures on the same `/rpc` handler (`packages/contracts/src/rpc.ts`). Postgres `NOTIFY` (`packages/adapters/src/realtime.ts`) wakes the server. The client still receives events on the HTTP stream it already opened.

These stay HTTP even in the proposed end state, because something other than the signed-in person calls them, or they are the local/LAN path:

| Path | Why it stays HTTP |
| --- | --- |
| `/api/v1/messaging/webhook` | `apps/api/src/messaging-webhook.ts`. Platforms post here. |
| `/api/v1/bots/:botId/webhook` and `.../github` | `apps/api/src/webhook.ts`, `apps/api/src/github-webhook.ts`. |
| `/api/v1/billing/webhook` | `apps/api/src/billing-webhook.ts`. |
| `/api/v1/messaging/install/slack/callback` | `apps/api/src/app.ts`. Browser redirect from Slack. |
| `/api/internal/screen-target` | The node's own screen proxy, not the remote user. |
| `/api/devices/connect` | WebSocket from the desktop app to *its* node. See below. |

A node with no inbound ports cannot receive provider webhooks or Slack's browser redirect until a tunnel (v0) or a gateway forwarder exists. That forwarder would be signaling-adjacent and must not persist the body. It is not required for v1 chat.

### `/api/devices/connect` is not the gateway link

`USER_DEVICE_CONNECT_PATH` is `/api/devices/connect` (`packages/contracts/src/user-devices.ts`). `UserDeviceHub.handleUpgrade` (`packages/adapters/src/user-device-gateway.ts`) accepts that path only, and `apps/api/src/index.ts` attaches it to the API server. The desktop app dials it so a bot can run commands on the person's computer. The socket is node-local: the Electron app that sits with the node, or a desktop signed into that node. It is not how a phone at vnbot.run reaches the node, and it is not the node agent's outbound signaling connection. Do not multiplex chat RPC onto it.

## `ClientTransport`

Proposed seam. Not in the repo. Web `RPCLink.fetch` and mobile `rpc` / `subscribeThread` would call it instead of hard-coding `fetch` to an origin. oRPC procedure names and JSON bodies stay the same. The HTTP handler in `apps/api/src/app.ts` stays for v0 and for LAN.

```ts
interface ClientCall {
  procedure: string;
  body: Uint8Array;
  headers: Record<string, string>;
  signal: AbortSignal;
}

interface ClientResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface ClientTransport {
  call(request: ClientCall): Promise<ClientResponse>;
  /** threads/subscribe and boards/subscribe: the same bytes as the HTTP event stream. */
  subscribe(request: ClientCall): AsyncIterable<Uint8Array>;
}
```

- `HttpClientTransport` — today's behavior. Web: `origin + "/rpc"` and cookies. Mobile: `apiBase + "/rpc"` and `Authorization: Bearer`.
- `DataChannelClientTransport` — frames `call` and `subscribe` over one `RTCDataChannel` to the node. The first frame is the gateway assertion. The node answers with a local bearer or binds the channel to the verified user. Later frames are the same `/rpc` payloads `RPCHandler` already accepts, including `text/event-stream` chunks for subscribe. A subscribe is a long-lived channel message stream, not a second HTTP response.

Auth clients stay beside this seam. Gateway sign-in (email at vnbot.run) is not `apps/web/src/lib/auth.ts` pointed at the node. Node sign-in for LAN keeps that client. Remote chat uses the bearer the node issued on the channel.

Voice `fetch("/api/voice/...")` and the relative `/api/auth` helpers have to take the same transport or an explicit node base. Leaving them relative sends them to vnbot.run.

## Better Auth: what stays where

Keep the node's Better Auth where it is: `createAuth` in `packages/auth/src/index.ts`, tables `User`, `Session`, `Account`, `Passkey`, and `bootstrapUserSpace` in `packages/db/src/bootstrap-user.ts`. That stack is the authority for a space, RLS, and `/rpc`. A Mac mini on a desk with no internet must still sign someone in.

Do not point the node's `DATABASE_URL` at the gateway, and do not replicate thread or message tables.

The gateway gets a separate, small account store: email sign-in, session, and the node registry. It can be another Better Auth process with its own database. It does not replace `packages/auth` on the node, and it does not receive the node's session cookie. Password reset and passkeys for *local* node login stay on the node. Passkeys for *vnbot.run* are the gateway's relying party and must not reuse the node's `rpID`.

The link between the two is the pairing record, not a shared user primary key. The assertion names the gateway user. The node maps that to the local `User` it created or bound at pairing, then `getSession` / `signedBearer` works as it does for mobile.

## Offline, NAT, and TURN

- The node agent reconnects outbound when the network returns. While it is down, vnbot.run shows the node offline and has no chat to queue.
- A phone on cellular and a Mac mini at home often fail direct ICE. TURN then relays the data channel. Chat and the event stream are small. Cost follows hours of relay, not rows stored.
- Prefer a host or server-reflexive candidate when the client is on the same LAN as the node, so TURN is the fallback rather than the default.
- v2 media (screen or voice between the person and the node) is the expensive case. Do not turn it on by default on the relay.
- v0's tunnel is a different cost: a public HTTPS name and a hop for every request, including when the person is at home. It is the bridge until the data channel exists, not the steady state.

## Phases

**v0 — HTTPS to the node through a tunnel.** No WebRTC. The node, or a tunnel in front of it, has a public `https` origin. Mobile already stores that origin. Web and desktop grow an explicit node base (or the tunnel serves the web UI so same-origin still holds). Cookies work only if the page origin is that tunnel. A page served by vnbot.run must use the bearer path, not `credentials: "include"` to `/rpc` on vnbot.run. Provider webhooks can target the tunnel. The gateway registry can list the tunnel URL, but chat is still HTTP to the node.

**v1 — WebRTC data channel.** Add the node agent, signaling, and TURN on the gateway. Ship `DataChannelClientTransport` behind `ClientTransport`. Web `RPCLink`, mobile `rpc` and `subscribeThread`, and the relative `/api/auth` and `/api/voice` calls used from a gateway page go through it. LAN and v0 keep `HttpClientTransport`. The node still serves `/rpc` over HTTP for that transport. No inbound port is required for v1.

**v2 — media on the same peer connection.** Audio or a screen track from the node to the client, still authorized by the v1 assertion. This does not replace the node's own screen proxy, and it does not move pixels into the gateway. TURN cost is why it is a later phase.

## Consequences

- A review of a gateway page that calls `fetch("/rpc/...")` or `fetch("/api/auth/...")` is a bug. Those paths are the node.
- The gateway database is not a second place to put `Thread`, `Message`, `Run`, or `VaultCredential`.
- `docs/architecture/rakazo-baseline/` stays the description of one node. This ADR is how a person reaches that node from vnbot.run.
