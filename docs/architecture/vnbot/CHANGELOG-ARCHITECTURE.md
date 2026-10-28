# Architecture changelog

Each entry is a change versus the frozen Rakazo baseline at commit `c4b24547` (`docs/architecture/rakazo-baseline/SYSTEM_MAP.md`). Record the date, what changed, why, which files or modules moved, which invariants moved, and the ADR or PR.

Proposed decisions are listed so reviewers can see them. They do not change the running system until a later entry says they landed in code.

## 2026-10-28 — Email-code sign-in and the phase-1 invite list

- What changed versus baseline: `AUTH_EMAIL_CODE_ONLY` closes password sign-in, sign-up, reset, and password changes without closing email codes or passkeys. `AUTH_EMAIL_ALLOWLIST=on` reads a new `auth_email_allowlist` table before a code is sent, before a user is created, and before a session is created. A missing address gets HTTP 403 `EMAIL_NOT_INVITED` and no mail. While that flag is on, the send-code route allows 5 requests per 15 minutes per IP (10 otherwise). Sign-in code mail is Vietnamese by default and English when `x-rakazo-locale` says so. The code is not in the subject. A new account with no chosen name stores the local part of the email.
- Why: VNBot's first sign-in is email, then a 6-digit code, invite-only. `passwordAuth: false` would also disable codes and passkeys and require OIDC, so it is not the switch.
- Files / modules: `packages/auth`, `packages/contracts` (`EMAIL_NOT_INVITED`), `packages/db` (schema, migration, row security), `apps/api` (env, capabilities, `email-allowlist` CLI).
- Invariants affected: password routes can be refused while email codes and passkeys still open a session. With the invite list on, an address outside `auth_email_allowlist` cannot receive a code, create a user, or create a session. The table is system-only under row-level security. Allowlist reads run in a system context so that connection has `app.rls_bypass` on. Threads, runs, and vault rows are unchanged.
- Links: [ADR 0002](adr/0002-email-code-sign-in-and-invite-list.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/2

## 2026-10-28 — Avatar set `vnbot`

- What changed versus baseline: the bot avatar contract accepts `vnbot` beside `organic` and `rakazo`. `resolveBotAvatarSet` keeps `vnbot` instead of folding it into `organic`. New bots default to `vnbot`. The id seed matches the logo set (no organic family). Body colour is `seededVnbotBodyColor`, which indexes `vnbotBodyColors` in `@rakazo/ui-tokens` (the twelve palette hexes, `la-ma` through `cham`). No database migration: `bots.avatarSet` is text and stays default `rakazo` at the column.
- Why: VNBot mascots are a third set. Duplicate and import must not turn a vnbot bot into organic.
- Files / modules: `packages/contracts/src/bot-avatar.ts`, `packages/db/src/bot-avatar-choice.ts`, `packages/core/src/logo-avatar-traits.ts`, `packages/ui-tokens/src/index.ts` (`vnbotBodyColors`).
- Invariants affected: unknown sets still resolve to `organic`. Stored `organic` and `rakazo` rows are unchanged. A client that does not render `vnbot` falls through to the organic avatar.
- Links: [ADR 0003](adr/0003-vnbot-avatar-set.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/2

## 2026-10-28 — No architecture change yet

- What changed versus baseline: nothing in code or data. Clients still call one Rakazo HTTP origin. A wrong draft of ADR 0001 (screen sharing over WebRTC) was discarded before implementation.
- Why: VNBot will be a hosted gateway at vnbot.run plus a self-hosted node (the full stack on the customer's machine). The gateway signs people in, lists nodes, and helps them connect. Chat stays on the node. The connection should become a WebRTC data channel, with TURN only as fallback.
- Files / modules: documentation only. `docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md` (status Proposed) names the gateway, the node agent, and a `ClientTransport` seam in front of today's `/rpc` and `/api/auth` calls. No module moved.
- Invariants affected: none. The node's thread ownership, run lease, RLS, and approval gate are unchanged. The gateway must not become a second store for those rows.
- Links: [ADR 0001](adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/1
