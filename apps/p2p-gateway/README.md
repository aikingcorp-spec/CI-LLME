# P2P gateway

The gateway handles pairing, node discovery and signaling. Application RPC and chat stay on the customer's node.

## Optional TURN credentials

Configuration names: `TURN_SECRET` (secret), `TURN_URLS`, `TURN_TTL_SECONDS`.
Keep configuration in environment bindings and secrets; never embed a shared secret in a client or repository.

`TURN_URLS` accepts comma-separated `turn:` and `turns:` URLs, with optional `?transport=udp` or `?transport=tcp`. The coturn test realm is `vnbot-p2p-test`; its TURN UDP/TCP port is 3479 and TURN TLS port is 5350. Realm selection belongs to coturn, not the ICE response.

`TURN_TTL_SECONDS` defaults to 600 seconds and is capped at 3600. Missing, invalid or non-positive TTL settings use the default. Missing `TURN_SECRET` or missing/invalid `TURN_URLS` leaves the authenticated endpoint at HTTP 501.

`GET /turn-credentials?peer=<peer-id>` requires the same authorization as signaling: a browser's `Assertion` credential or a paired node's signed `Node` proof. The peer must match that credential; revoked nodes and foreign owners are refused. Browser TURN credentials cannot outlive their assertion.

A successful response is an ICE server object with `urls`, `username`, `credential` and `ttl` (seconds). coturn REST authentication uses `<expiry>:<peer-id>` as the username and base64 HMAC-SHA1 as the credential. Responses are not cached.

Web appends this object to configured STUN entries before connecting. Desktop fetches fresh credentials for each incoming connection and translates the same response for node-datachannel. Both retain their STUN configuration on HTTP 501, request errors or malformed responses. Optional credential discovery times out after three seconds. Credentials stay in memory and are not logged.

Credential issuance allows ten requests per minute per authenticated user or node, shared across Worker instances. Fresh assertions and browser peer IDs do not reset the user counter. Exhaustion returns HTTP 429 with `Retry-After` in seconds. Apply the additive D1 migration `0002_turn_rate_limits.sql` before running this gateway version; previous versions remain compatible with the new table. From `apps/p2p-gateway`:

```sh
wrangler d1 migrations apply vnbot-p2p-d1 --remote
```

Browser HTTP requests and WebSocket upgrades must have an Origin in `ALLOWED_ORIGINS`. Native callers may omit Origin and still require their existing credentials.

The web client and its CSP read `VITE_P2P_GATEWAY_URL` from the existing Vite environment configuration. An unset or blank value turns P2P off: there is no default gateway, the account menu hides "Pair a computer", `/app/pairing` shows a configuration error, no token is requested, and the web app keeps direct API access without node selection. Any gateway, including production, requires explicit configuration when the bundle is built and when it is served. Only HTTPS origins or loopback HTTP origins are accepted.
