# Decisions

Product decisions approved by the owner/PM that intentionally diverge from a spec, newest last.

- 2026-10-31 Maya: the 'Yêu cầu hệ thống' link stays hidden until the system-requirements doc exists; restore it per SPEC §2 when the doc ships. (VNB-008)
- 2026-10-31 Khoa: POST /api/auth/p2p-token accepts requests with no Origin header (non-browser clients: desktop app, CLI); authentication relies on the session (cookie, or signed Authorization: Bearer via the bearer plugin), not on Origin. A request that sends an Origin must pass isTrustedOrigin or gets 403 `forbidden`, so a browser on a disallowed site cannot mint a token with the user's cookie; JSON content-type is also required (415) and no session gives 401 NO_SESSION. Code: apps/api/src/p2p-token.ts:103-110, apps/api/src/app.ts:841-844 and 1385-1393. (VNB-022)
