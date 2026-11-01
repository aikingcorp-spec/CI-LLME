# ADR 0010: Desktop account enrollment and local session binding

Status: Implemented in code, deployment and cross-network acceptance pending.

The desktop's native node uses the existing hosted email OTP protocol. Main verifies the account response and obtains a short-lived, pair-scoped application token. It opens the corresponding local account through the existing private desktop capability pattern from PR #29, then registers a machine key with the gateway. A submitted email alone cannot register a device or open a remote connection.

Registration requires both the application signer's token and a machine signature over the node ID and exact token. D1 retains the account ID and public key. Repeated registration with a new token and the same owner/key is idempotent. Another account, another key and a revoked node ID cannot take over that record. The gateway public key and the local user ID are pinned in the desktop's private identity file. Each native launch verifies the local session's user ID before sharing RPC.

The data-channel handshake still verifies the gateway assertion, owner, node, expiry and bearer. The local HTTP adapter discards remote credentials and injects the node's local session inside the isolated agent process. Only canonical RPC procedure names and selected RPC headers pass. The gateway never sees the local cookie or product data. Gateway revocation closes the agent link, which closes its data channels. No HTTP product fallback is introduced.

The agent names its node in the WebSocket query so the hosted Worker can select its Durable Object before accepting the signed hello. This routing value grants no access; the room still verifies the machine's signature. Local Workers runtime acceptance verifies registration, online/offline discovery, native RTC and revocation with the shipped D1 migrations and Durable Object implementation.

Native host-computer listeners bind loopback. Docker mode explicitly retains host-gateway networking and its existing secret/consent checks. Linux and Windows use the same enrollment protocol, native process boundary and user-data storage. Windows execution must be verified in its CI runner; Linux tests alone cannot certify it.

New desktop installs default to running this computer's node. Saved choices still take precedence. Main marks managed local windows in their isolated preload; those windows keep direct local RPC. A desktop window showing the hosted app uses the same remote node gate and data channel as a browser. The routing hint grants no IPC permission.

The hosted app Worker serves the real web build. It forwards only the required account endpoints to an explicitly configured account service. Product API, arbitrary auth endpoints, screen routes and source maps are refused. The existing landing deployment is separate and unchanged.

The browser verifies RPC `me` over the authenticated channel before reporting connected. Product query/author identity uses that node user ID; the gateway account ID remains the login and discovery identity. They are never assumed equal.

The browser remembers only a node ID under the signed-in account's session-storage key. Restoration checks the account's current node list before connecting. Closed channels retry with fresh assertions and bounded backoff. Existing assertion expiry and revocation remain authoritative.

This work does not certify Internet NAT/TURN behavior or publish new desktop installers. The account service must have its application signing key configured, the gateway must trust that public key, and the public gateway/relay must be available before production acceptance.
