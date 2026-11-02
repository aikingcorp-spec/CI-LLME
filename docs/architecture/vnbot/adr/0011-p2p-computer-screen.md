# 0011 — Computer screen through the authenticated node channel

Status: Implemented, production acceptance pending.

## Context

The hosted application transports product RPC over WebRTC. Its Worker refuses `/novnc` paths, so embedding a node-issued screen URL at the hosted origin cannot load the existing screen proxy. The local web service already verifies sealed view/control capabilities, rechecks generation and control leases, and closes revoked upstream screen sockets.

## Decision

`ComputerScreenFrame` keeps the existing local iframe when hosted P2P is disabled. With an active P2P client it embeds a trusted bundled noVNC viewer at `/p2p-screen.html` and opens the capability's socket through `WebP2PClient.openScreen(path, signal)`.

The shared channel protocol multiplexes authenticated socket-open/data/ack/close frames alongside RPC. The server owns socket state per authenticated channel, permits two concurrent screen sockets and closes them on bearer expiry, revocation or channel termination. A socket-open request can reach only `/novnc/session/{view|control}/{sealed-capability}/websockify` at the preconfigured local web service. The browser resolves the API-issued relative `websockify` form or its absolute equivalent only within that same sealed capability prefix. Arbitrary URLs, query strings, mismatched capability prefixes and other local paths are refused. The connector does not follow redirects or receive browser-supplied local credentials.

The existing local screen proxy remains the authority for capability scope, view/control policy and ongoing revocation. The connector never decrypts capabilities or connects directly to a provider, VNC port, database or arbitrary host. No account or gateway key changes are needed, and screen bytes remain on the WebRTC channel.

Each socket direction allows one 16 KiB chunk in flight, acknowledged only as the consumer advances. A ten-second acknowledgement timeout terminates the socket. The MessagePort bridge between parent and viewer also waits for consumption acknowledgements; viewer input queues are bounded at 512 KiB. Screens cannot accumulate unlimited video buffers or hold the entire RPC connection hostage while hidden or stalled.

The viewer contains pinned noVNC code bundled from its npm package; provider HTML/scripts are never loaded. A ready handshake waits for the viewer module to finish initializing; noVNC decoder feature discovery may continue after the document load event. It receives RFB bytes over a dedicated MessagePort, not an account session, node bearer, signing key or screen capability URL. It permits framing by the app origin, runs only bundled scripts and has `connect-src 'none'`. Its same-origin sandbox permission is intentional for trusted bundled code, not for arbitrary provider content. View-only rendering follows the API-issued policy; takeover continues through the existing authenticated API and lease checks.

## Alternatives

Proxying `/novnc` through the public app or opening a public node VNC endpoint would introduce a product HTTP bypass and is rejected. A generic HTTP tunnel plus service-worker interception would also expose many more paths and lifecycle states just to load a viewer. Bundling the viewer and transporting only its capability-bound socket keeps the hosted boundary narrow.

## Consequences and validation

Chat, local web/desktop screens and the existing API screen authority remain compatible. Older clients retain RPC and ignore the optional screen feature; a new client needs a node agent that understands socket frames. Deployment updates the agent before the web assets; rollback restores web first.

Regression coverage includes bounded duplex transfer over real RTC and WebSocket, closing the upstream on channel revocation, refusing arbitrary local socket paths, RPC surviving rejected/closed screens, and Chromium drawing a fixture framebuffer through the application component. Production acceptance must separately observe the actual VPS screen and the user's browser. Voice/media HTTP are outside this decision.
