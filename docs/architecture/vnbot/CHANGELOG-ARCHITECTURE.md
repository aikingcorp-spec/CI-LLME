# Architecture changelog

Each entry is a change versus the frozen Rakazo baseline at commit `c4b24547` (`docs/architecture/rakazo-baseline/SYSTEM_MAP.md`). Record the date, what changed, why, which files or modules moved, which invariants moved, and the ADR or PR.

Proposed decisions are listed so reviewers can see them. They do not change the running system until a later entry says they landed in code.

## 2026-10-29 — Vietnamese web fallback independent of build env

- Pull request: none (local change).
- What changed versus baseline: web locale resolution uses saved `rakazo.uiLocale`, then a supported optional `VITE_DEFAULT_UI_LOCALE`, then Vietnamese. Browser language no longer participates; unsupported env values fall back to Vietnamese.
- Why: `.env.*` files are excluded from the Docker build context, so the web default must hold without `.env.production`.
- Files / modules: `apps/web/src/lib/ui-locale.ts`, `apps/web/src/lib/ui-locale.test.ts`.
- Invariants affected: saved-choice normalization and storage key are unchanged. Playwright retains its English env override. Shared core and mobile locale behavior are unchanged.
- ADR: [0004](adr/0004-vietnamese-default-locale.md) (update).

## 2026-10-29 — VN Bot wordmark swap

- What changed versus baseline: the web wordmark SVGs and the sign-in email PNG are the new "VN Bot" artwork. The aspect ratio is narrower (SVG viewBox 445.5×87.4 to 383.4×100.1, powered 445.5×123.4 to 383.4×136.1; email PNG 446×87 to 240×63, `@2x` 480×125). The sign-in code email keeps its 32 px height, so the `<img>` width is 123 in the VI and EN templates (was 164). Web components size the wordmark by height only and are unchanged.
- Why: the brand artwork changed. A fixed 164 px width on the new image would stretch it.
- Files / modules: `packages/auth/src/sign-in-code-templates.ts`, `apps/web/public/brand/vnbot-wordmark-*.svg`, `apps/web/public/email/vnbot-wordmark-light*.png`.
- Invariants affected: none. Sign-in code mail still shows the wordmark at 32 px height with alt text `VNBot`.
- ADR: none.

## 2026-10-29 — SSO redirect origin, ACCOUNT_NOT_LINKED, send-limit order, compose defaults

- What changed versus baseline: SSO callback redirects are built from the configured web origin instead of the Host header. An SSO email that already has an account gets a bare 302 to `/sign-in?error=ACCOUNT_NOT_LINKED` (no implicit linking; link from Settings while signed in), with VI/EN copy in `@rakazo/contracts`. The per-address send bucket is consumed only after the invite check passes; uninvited addresses get 403 and are limited per IP only. Compose defaults are `AUTH_EMAIL_ALLOWLIST=on` everywhere and `AUTH_EMAIL_CODE_ONLY=true` only in the production stack (code-only refuses to start without an email sender).
- Why: Rex review v2 of pull request 2 (N1 open redirect, N2 linking, N3 lockout, N4 safe defaults).
- Files / modules: `packages/auth/src/index.ts`, `packages/contracts/src/auth.ts`, `apps/web/src/lib/user-error.ts`, `infra/compose/*.yml`.
- Invariants affected: no auth redirect depends on request headers. Requests for other addresses cannot lock an invited address out of codes.
- Links: [ADR 0002](adr/0002-email-code-sign-in-and-invite-list.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/2

## 2026-10-29 — VNBot default avatar, sign-in language switch, review fixes

- Date: 2026-10-29
- Pull request: this pull request (review fixes on top of the 2026-10-28 entry). It depends on pull request #2 (`cursor/vnbot-ui-wave1-backend-8223`) and should merge after it.
- What changed versus the baseline: new bots default to the `vnbot` avatar set. The default comes from `DEFAULT_NEW_BOT_AVATAR_SET` in `packages/contracts`, as pull request #2 defines it; this change does not redefine it. There is one seeded body color, `seededVnbotBodyColor` in `packages/core/src/logo-avatar-traits.ts`, which draws from `vnbotBodyColors` in `packages/ui-tokens`. `packages/core/src/vnbot-palette.ts` keeps only the tone lookup and no longer has its own palette or seed. Welcome and the sign-in frame show a vi/en `LanguageSwitch`. The email-code step survives a reload through `sessionStorage` key `vnbot.signIn`. The "Get in touch" link reads `VITE_VNBOT_CONTACT_URL` (default `https://aikingx.com`). The web client handles HTTP 401 `EMAIL_NOT_INVITED` from the API by clearing the space, signing out and opening `/sign-in?error=EMAIL_NOT_INVITED`, which shows the not-invited screen. The web light `input` and `faintForeground` tokens and the web dark `input` token changed (VNBot web themes only).
- Why: review findings from Rex (sign-in accessibility, losing the code step on F5, a missing language control before sign-in, copy) and Mai (input and faint-text contrast). Pull request #2 owns the avatar contract. A second seed and palette in `@rakazo/core` would give a duplicate export and two different colors for the same bot.
- Files / modules: `packages/contracts`, `packages/db`, `packages/core` (avatar default and seed, the same as pull request #2), `packages/ui-tokens` (`webLightOverrides.input`, `webLightOverrides.faintForeground`, `webDarkOverrides.input`, regenerated `tokens.css`), `apps/web` (`components/LanguageSwitch.tsx`, `lib/sign-in-progress.ts`, `lib/vnbot-links.ts`, `pages/Welcome.tsx`, `pages/Auth.tsx`, `components/PasskeySignIn.tsx`, `pages/shell/create-bot-dialog.tsx`, the vi and en catalogs).
- Invariants affected: `rakazo.uiLocale` stays the only saved locale key; the switch calls the same `setUiLocale` as Settings. The sign-in code is never stored; `sessionStorage` holds only the email, the step and the send time, and they are cleared on sign-in. Mobile tokens are unchanged. Existing bots keep their stored avatar set.
- ADR: [0006](adr/0006-sign-in-language-switch-and-step-restore.md), [0007](adr/0007-vnbot-default-avatar.md); tokens amend [0002](adr/0002-web-brand-color-tokens.md).

## 2026-10-29 — Invite list hardening after review

- What changed versus baseline: removing an invite deletes that account's sessions, and a live session whose address left the list is deleted on read (401 `EMAIL_NOT_INVITED`). The OIDC callback answers a bare 302 to `/sign-in?error=EMAIL_NOT_INVITED` for an uninvited provider email, with no cookie or rows. Email normalization is trim, NFC, zero-width strip, lowercase, in code and in the table CHECK. The send-code limit is also keyed on the normalized address (5 per 15 minutes with the list on, 10 otherwise) and holds outside production while the list is on; the counter uses conditional writes so concurrent sends cannot pass the cap. `auth_email_allowlist` has FORCE row-level security with a WITH CHECK policy, and the runtime login lost UPDATE on it. `bootstrap-owner` invites the owner after the account is verified or created. Sign-in code locale is read only from `x-rakazo-locale`. Failed deliveries reach `onEmailError` without the message text.
- Why: review of pull request 2 (Rex items 1, 3–10).
- Files / modules: `packages/auth` (`index.ts`, `email-allowlist.ts`), `packages/db` (allowlist migration, `database-access.ts`), `apps/api` (`cli/bootstrap-owner.ts`), `infra/compose` (the two new env vars).
- Invariants affected: an address off the list cannot keep a session. Allowlist rows cannot be read, written, or updated by the runtime login without the system context, and cannot be updated at all. Delivery errors never carry a code to the logs.
- Links: [ADR 0002](adr/0002-email-code-sign-in-and-invite-list.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/2

## 2026-10-28 — Email-code sign-in and the phase-1 invite list

- What changed versus baseline: `AUTH_EMAIL_CODE_ONLY` closes password sign-in, sign-up, reset, and password changes without closing email codes or passkeys. `AUTH_EMAIL_ALLOWLIST=on` reads a new `auth_email_allowlist` table before a code is sent, before a user is created, and before a session is created. A missing address gets HTTP 403 `EMAIL_NOT_INVITED` and no mail. While that flag is on, the send-code route allows 5 requests per 15 minutes per IP and per address (10 otherwise). Sign-in code mail is Vietnamese by default and English when `x-rakazo-locale` says so. The code is not in the subject. A new account with no chosen name stores the local part of the email.
- Why: VNBot's first sign-in is email, then a 6-digit code, invite-only. `passwordAuth: false` would also disable codes and passkeys and require OIDC, so it is not the switch.
- Files / modules: `packages/auth`, `packages/contracts` (`EMAIL_NOT_INVITED`), `packages/db` (schema, migration, row security), `apps/api` (env, capabilities, `email-allowlist` CLI).
- Invariants affected: password routes can be refused while email codes and passkeys still open a session. With the invite list on, an address outside `auth_email_allowlist` cannot receive a code, create a user, or create a session. The table is system-only under row-level security. Allowlist reads run in a system context so that connection has `app.rls_bypass` on. Threads, runs, and vault rows are unchanged.
- Links: [ADR 0002](adr/0002-email-code-sign-in-and-invite-list.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/2

## 2026-10-28 — Web brand, email-code sign-in, Vietnamese default

- Date: 2026-10-28
- Pull request: this pull request
- What changed versus the baseline: the web and Electron color tokens use the VNBot olive primary, link, and sidebar accent. The web sign-in page is email then a 6-digit code, and `/sign-up` redirects to `/sign-in`. Vietnamese is a web locale and the default when nothing is saved. Inline mascot SVGs prefix their ids per instance. A `vnbot` bot avatar set is accepted; new bots still default to `rakazo` (superseded on 2026-10-29: the default is `vnbot`).
- Why: the web product is VNBot, in Vietnamese, with one invite-aware sign-in and brand green. Mobile palettes and the password change screen inside settings stay as they were. The auth server returns HTTP 403 `{ code: "EMAIL_NOT_INVITED", message: "This email is not invited yet" }` using the existing Better Auth error body; this change only reads that code. The send-code request sends `x-rakazo-locale` (`vi` or `en`) because the body schema drops unknown fields.
- Files / modules: `packages/ui-tokens` (web overrides and `tokens.css`), `packages/ui-web` (palette stylesheet, link button, mascot avatar, SVG id prefix), `packages/contracts` (`vnbot` on the avatar-set enum), `packages/core` (body palette), `packages/db` (seeded mascot color when the set is `vnbot`), `apps/web` (welcome, auth, sidebar, locale, PWA name and icons).
- Invariants affected: web primary is no longer ink. Sign-in on the web no longer collects a password. `rakazo.uiLocale` and `rakazo.uiAppearance` are unchanged. Chat, runs, and RLS are unchanged. Mobile color tokens are unchanged.
- ADR: [0002](adr/0002-web-brand-color-tokens.md), [0003](adr/0003-email-code-sign-in.md), [0004](adr/0004-vietnamese-default-locale.md), [0005](adr/0005-inline-svg-id-prefixes.md)

## 2026-10-28 — No architecture change yet

- What changed versus baseline: nothing in code or data. Clients still call one Rakazo HTTP origin. A wrong draft of ADR 0001 (screen sharing over WebRTC) was discarded before implementation.
- Why: VNBot will be a hosted gateway at vnbot.run plus a self-hosted node (the full stack on the customer's machine). The gateway signs people in, lists nodes, and helps them connect. Chat stays on the node. The connection should become a WebRTC data channel, with TURN only as fallback.
- Files / modules: documentation only. `docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md` (status Proposed) names the gateway, the node agent, and a `ClientTransport` seam in front of today's `/rpc` and `/api/auth` calls. No module moved.
- Invariants affected: none. The node's thread ownership, run lease, RLS, and approval gate are unchanged. The gateway must not become a second store for those rows.
- Links: [ADR 0001](adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/1
