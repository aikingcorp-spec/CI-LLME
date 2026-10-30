# Architecture changelog

## 2026-10-30 — Source maps answer 404 in the web server

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: the web dev and preview servers answer 404 for any request path ending in `.map`, raw or URL-decoded, before static file handling.
- Why: a stale source map left in the served assets (or asset archive) was publicly readable.
- Modules and files: `apps/web/vite.config.ts`, `apps/web/src/missing-asset.ts` and its test.
- Invariants affected: no files are deleted; hashed JS and CSS assets and the missing-asset fallback behave as before.
- ADR: none.

## 2026-10-30 — A model server address must answer before it is saved

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: saving an OpenAI-compatible connection with a new server address, or a new key for it, first requests `{base}/models` with a 5 second budget. A failure rejects the save with a stable message (status, timeout or unreachable) that the web client translates. Saves that only change limits or models on a stored address do not contact the server. The three messages are shared constants in `packages/contracts/src/model-provider.ts`.
- Why: a wrong address saved without any check and the settings screen reported it as saved.
- Modules and files: `apps/api/src/model-credentials.ts`, `packages/adapters/src/pi-openai-compatible-provider.ts`, `packages/contracts/src/model-provider.ts`, `apps/web/src/lib/user-error.ts` and their tests.
- Invariants affected: the existing address policy (private endpoints, HTTPS for keyed endpoints) is checked first and unchanged; secrets are stored only after the check passes. No hosted provider is involved.
- ADR: none.

## 2026-10-30 — /version answers with the deployment version

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: `GET /version` returns the same JSON as `GET /api/version` (`sha`, `builtAt`). The API serves both paths, the web dev and preview server proxy `/version` to the API, and both Caddyfiles route `/version` to the API.
- Why: `/version` fell through to the web server and returned the app shell.
- Modules and files: `apps/api/src/version.ts`, `apps/web/vite.config.ts`, `infra/compose/Caddyfile.prod`, `infra/compose/Caddyfile.cloudflare.example` and their tests.
- Invariants affected: the endpoint stays public, unauthenticated and uncached, and carries the same two fields as before.
- ADR: none.

## 2026-10-30 — Cloud-agent status, reply, cancel and purchase status tools removed

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: `cloud_agent_status`, `cloud_agent_reply`, `cloud_agent_cancel` and `purchase_status` are no longer built-in tools: not in the contract names, tool definitions, handlers, approval sets, selection options (`cloudAgentEnabled`, `paymentWalletEnabled`) or web labels and catalogs.
- Why: the launch and request tools were already removed, and the remaining four showed in the bot tool list with nothing to act on.
- Modules and files: `packages/contracts/src/builtin-tools.ts`, `packages/adapters/src/{builtin-tools,run-tools,run-tools-integrations,run-tool-selection,run-tool-request,executor}.ts`, `packages/core/src/action-approval.ts`, `apps/web/src/lib/builtin-tool-labels.ts`, web locale catalogs and their tests.
- Invariants affected: approval gating for the remaining tools is unchanged. Stored cloud-agent and purchase rows and their worker jobs are untouched.
- ADR: none.

## 2026-10-30 — Plugin preview no longer fails on brand words in a manifest

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: `capabilities.pluginPreview` refuses a plugin only when its name, homepage, repository or MCP endpoint hosts are a banned brand. Banned words in its description or keywords are blanked in the response instead of failing the request.
- Why: Sentry's manifest says "Sentry Plugin for Grok", so every preview returned HTTP 400 and the app could not be added.
- Modules and files: `apps/api/src/routes/mcp.ts`, `apps/api/src/catalog-text.ts` and their tests.
- Invariants affected: the MCP endpoint check, digest pinning and install flow are unchanged.
- ADR: none.

## 2026-10-30 — Brand filter judges what names an item, not where it is installed from

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: marketplace entries and integration results are dropped only when their name, homepage, domains or hosts are a banned brand (`xAI`, `x.ai`, `cursor.com`, `VNBot Voice/SDK/Bot`). Install sources are never judged and prose is blanked instead of hiding the item. Plugin preview no longer refuses a plugin by its install source. The keyword filter uses the same whole-word and whole-host rule as the rest, and the lint guard anchors `xai`, `grok`, `x.ai` and `cursor.com` to word and host boundaries.
- Why: plugins vendored in the Cursor and xAI registry repositories carry that owner in their install source, so Stripe, Supabase, GitHub, Linear, Slack, Vercel, HubSpot, Asana, Jira and Notion were all hidden.
- Modules and files: `packages/core/src/banned-brand.ts`, `apps/api/src/catalog-text.ts`, `apps/api/src/routes/mcp.ts` and their tests.
- Invariants affected: install sources, ids and pins are unchanged; banned brand names and hosts are still never shown.
- ADR: none.

## 2026-10-30 — Preserve explicit approval checker configuration

- Date: 2026-10-30.
- Pull request: none (local commit).
- What changed versus baseline: approval resolution honors explicit member choices, then explicit deployment approval configuration, and otherwise follows the member's primary model. Configured approval backups also run without a primary checker.
- Why: defaulting approvals to the primary model must preserve explicitly configured deployment checkers and backup fallback.
- Modules and files: `packages/adapters/src/model-roles.ts`, `packages/adapters/src/run-tool-gate.ts`, and their model-role and executor approval tests.
- Invariants affected: selected connections retain precedence and fail closed when unavailable; deployment checkers retain environment-key support. No implicit deployment chat model becomes an approval default, and no provider becomes required.
- ADR: none; regression fix within existing approval boundaries.

Each entry is a change versus the frozen Rakazo baseline at commit `c4b24547` (`docs/architecture/rakazo-baseline/SYSTEM_MAP.md`). Record the date, what changed, why, which files or modules moved, which invariants moved, and the ADR or PR.

Proposed decisions are listed so reviewers can see them. They do not change the running system until a later entry says they landed in code.

## 2026-10-29 — Approval follows the selected primary model

- Date: 2026-10-29.
- Pull request: none (local change).
- What changed versus baseline: when no approval model is selected, the API settings view and runtime approval resolution follow the member's primary model and its connection, including the requested account or space scope. No implicit hosted approval model is advertised when the primary is empty.
- Why: an unconnected provider was displayed as the approval default, implying a model was available without a user connection.
- Modules and files: `packages/adapters/src/model-roles.ts` and tests; `apps/api/src/routes/context.ts`, `apps/api/src/routes/models.ts`, `apps/api/src/models-backups.test.ts`.
- Invariants affected: explicit approval choices and backups retain precedence; connection credentials and tenant scope remain intact. No migrations, gateway storage or required hosted providers.
- ADR: none; correction to default selection within existing boundaries.

## 2026-10-29 — Catalog registry value hidden; Sentry false positive fixed

- Date: 2026-10-29.
- Pull request: none (local commit).
- What changed versus baseline: marketplace responses no longer carry a banned brand as the registry name (`registry` and `unavailableRegistries` entries become empty; the value is removed, not renamed). URL values (install source, homepage, endpoints) are judged by host and owner (`xAI`, `x.ai`, `cursor.com`, `VNBot Voice/SDK/Bot`) and no longer by the word "grok", which matched repository slugs such as `getsentry/plugin-grok` and wrongly dropped Sentry. Names, descriptions and keywords keep the full rule.
- Why: the registry field showed xAI and Cursor to users, and the whole-word `grok` rule on install URLs hid a legitimate app.
- Files / modules: `packages/core/src/banned-brand.ts`, `apps/api/src/catalog-text.ts` and their tests.
- Invariants affected: install sources, ids and pins are unchanged; the guard still bans the same brand terms in text.
- ADR: none.

## 2026-10-29 — Server-side Wallet surface removed

- Date: 2026-10-29.
- Pull request: none (local change on `kai/wallet-server-removal`).
- What changed versus baseline: the `paymentWallet.status/connect/disconnect` RPC methods, their API route module and router wiring are gone. `me` no longer returns `paymentWalletProvider`. The mobile Wallet settings screen, its link and its strings are removed (web already had no wallet settings). The wallet security-audit entries and the wallet-connected audit event are removed. `docs/self-host/payments.md` now says wallets cannot be connected.
- Why: wallet connection is not part of VNBot; nothing in the product should let a user connect one.
- Files / modules: `apps/api/src/router.ts`, `apps/api/src/app.ts`, `apps/api/src/security-audit.ts`, `apps/api/src/routes/shared.ts`, `packages/contracts/src/rpc.ts`, `packages/contracts/src/domain.ts`, mobile settings and locales, web e2e helper, testkit harness.
- Invariants affected: the `payment_wallets` table, its migration, and all stored rows are untouched; no migration is added. Adapter-level purchase and wallet storage code stays, so `PAYMENT_WALLET_*` configuration still parses. Purchase tools are offered only to users with a connected wallet, so with no connect path they are never offered. No gateway data storage or mandatory hosted provider is introduced.
- ADR: none; removal of an exposed surface within existing boundaries.

## 2026-10-29 — Catalog content exclusion and preview recovery

- Date: 2026-10-29.
- Pull request: none (uncommitted local change).
- What changed versus baseline: API marketplace and integration search exclude entries whose content or URLs identify excluded third-party products before translation. Builtin/plugin skill lists apply the same policy, and direct excluded skill/preview requests are rejected. Foreign product names are no longer relabeled as VNBot. Preview failures return Vietnamese copy, retain diagnostics in server logs, and no longer remove searchable catalog entries merely because acquisition or parsing failed. Explicitly incomplete successful previews retain the existing suppression rule. The web empty search no longer shows managed-catalog deployment configuration details.
- Why: relabeling catalogs falsely advertised VNBot-provided services; failed previews also made apps disappear from subsequent searches.
- Files / modules: API catalog text, Vietnamese description map and tests; `apps/api/src/routes/mcp.ts`; `apps/api/src/routes/memory.ts`; shared banned-brand policy and lint checker/tests; web integrations search and Vietnamese locale; adapter plugin parser/tests and identity prompt.
- Invariants affected: filtering changes served discovery metadata, not upstream references, pins, digests, execution data, authored skills, authorization or endpoint validation. No gateway data storage, migrations or mandatory hosted provider is introduced.
- ADR: none; presentation and recovery corrections within existing boundaries.

## 2026-10-29 — Vietnamese web fallback independent of build env

- Pull request: none (local change).
- What changed versus baseline: web locale resolution uses saved `rakazo.uiLocale`, then a supported optional `VITE_DEFAULT_UI_LOCALE`, then Vietnamese. Browser language no longer participates; unsupported env values fall back to Vietnamese.
- Why: `.env.*` files are excluded from the Docker build context, so the web default must hold without `.env.production`.
- Files / modules: `apps/web/src/lib/ui-locale.ts`, `apps/web/src/lib/ui-locale.test.ts`.
- Invariants affected: saved-choice normalization and storage key are unchanged. Playwright retains its English env override. Shared core and mobile locale behavior are unchanged.
- ADR: [0004](adr/0004-vietnamese-default-locale.md) (update).

## 2026-10-29 — Skills catalog response branding

- Date: 2026-10-29
- Pull request: not opened; local backend change.
- What changed versus the baseline: the API applies the existing catalog text cleaner to third-party plugin previews, installed plugin names and preview metadata, and builtin/plugin skill list and detail responses. Plugin install and part-update responses use the same presentation mapping. Marketplace browse and integration search retain their existing cleaning.
- Why: the Skills screen also reads installed and preview metadata, so cleaning only marketplace browse leaves third-party brand terms visible.
- Files / modules: `apps/api/src/catalog-text.ts`, `apps/api/src/catalog-text.test.ts`, `apps/api/src/routes/mcp.ts`, `apps/api/src/routes/memory.ts`.
- Invariants affected: cleaning changes response copies only. Stored identifiers, upstream marketplace slugs, install sources, hashes, format enums, file paths, and execution data remain intact. User-authored and taught skills are unchanged. No gateway persistence or provider requirement is added.
- ADR: none; extends the existing catalog presentation rule.

## 2026-10-29 — Server-side audit fixes (APP-AUDIT-333cae3e)

- Date: 2026-10-29
- Pull request: branch `kai/audit-backend` (not yet opened), on top of `kai/vite-build-env`.
- What changed versus the baseline: integration catalog search and the plugin marketplace responses pass through one sanitizer at the API boundary (`apps/api/src/catalog-text.ts`) that rewords Grok Build, Grok, Rakazo, Cursor and "open source" in names, descriptions, categories and auth notes; banned keywords are dropped. Identifiers (id, source, registry key, URLs) are unchanged. Account emails (verification, reset, deletion, identity code, welcome, sign-in code) are VNBot-branded Vietnamese and signed "Đội VNBot"; the welcome mail no longer links GitHub or Discord; Better Auth `appName` and passkey `rpName` are `VNBot`. Every bot and subagent system prompt opens with a fixed VNBot identity (`packages/adapters/src/product-identity.ts`) that forbids calling itself Rakazo. Plugin skill and connector tool name conflicts answer the codes `PLUGIN_SKILL_CONFLICT` (RPC 409) and `CONNECTOR_TOOL_NAME_CONFLICT` (tool result) from `packages/contracts/src/capability-errors.ts`. The API never builds the Stripe billing provider from `STRIPE_*` (`apps/api/src/billing-off.ts`), so paid plans and model credits are off on every deploy. `infra/compose/check-image.sh` fails on any `*.map` outside `node_modules`.
- Why: Rex's audit of the 8088 node (rows 3, 11, 17, 19, 22, 23, 25, 28) and PRODUCT.md (brand VNBot, no paywall, no open-source mention).
- Files / modules: `apps/api` (`catalog-text.ts`, `routes/mcp.ts`, `billing-off.ts`, `app.ts`, `routes/context.ts`, `plugin-installs.ts`, `marketing-email.ts`), `packages/auth` (`email.tsx`, `welcome-email.tsx`, `sign-in-code-templates.ts`, `index.ts`), `packages/adapters` (`product-identity.ts`, `pi-runtime.ts`, `pi-runtime-subagent.ts`, `run-tool-request.ts`, `stripe-billing.ts`, `payment-wallets.ts`), `packages/contracts` (`capability-errors.ts`), `infra/compose` (`check-image.sh` and its smoke).
- Invariants affected: catalog install sources and ids are untouched, so installs and pins behave as before. Billing contracts and types are unchanged; `billing` in `/api/auth/capabilities` is always false unless a test injects a provider. The cached system-prompt prefix stays stable (the identity line is constant).
- ADR: none (copy, error codes and a deploy gate; no module moved).

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

## 2026-10-29 — Rebrand follow-up: Classic icon set, welcome email, marketing site, Android link

- Date: 2026-10-29
- Pull request: this pull request
- What changed versus the baseline: the `rakazo` avatar set keeps its internal id and image set, and its tab reads "Classic" (vi "Cổ điển") on web and mobile. The welcome email is Vietnamese first, then English, signed "Đội VNBot", with no outside links except the unsubscribe link, and its subject is "Chào mừng đến với VNBot". `ANDROID_APK_URL` in `packages/contracts` is `https://vnbot.run/#tai-ve`. The web run-error mapping also accepts the legacy "Rakazo credits" message. `apps/www` no longer carries open-source, Apache-2.0, GitHub or self-host-install copy and links: the four blog posts, the self-hosting guide page, the GitHub star pill, repo card, release-based desktop download redirect and setup-prompt button are gone, the site origin is `https://vnbot.run`, and the docs index drops the self-hosting section.
- Why: VNBot users should not meet the Rakazo name, the upstream repository, or open-source claims, and the Android build is offered from the VNBot site.
- Files / modules: `packages/contracts` (`client-build.ts`), `packages/auth` (`welcome-email.tsx`), `apps/web` (`avatar-studio-popover.tsx`, `lib/run-error.ts`, catalogs), `apps/mobile` (`bot-settings.tsx`, locale files), `apps/www`, `docs/getting-started.md`.
- Invariants affected: none. Stored avatar-set ids, package names, `@rakazo/*` imports and `RAKAZO_*` variables are unchanged. Runs that stored the legacy credits text now map to the same translation as the VNBot text.
- ADR: none

## 2026-10-29 — User-visible product name is VNBot

- Date: 2026-10-29
- Pull request: this pull request
- What changed versus the baseline: every string a person reads says VNBot instead of Rakazo: transactional and marketing emails, passkey and authenticator names, API and desktop messages, the installer and host alerts, app display names and permission prompts on desktop and mobile, Android call titles, the marketing site, and the web, mobile and Lingui catalogs. The sidebar no longer links to the external self-hosting guide. Source identifiers, package names, `@rakazo/*` imports, `RAKAZO_*` variables, storage keys, URL schemes, bundle ids, file names and image names are unchanged.
- Why: the product shows one brand to its users.
- Files / modules: `packages/auth`, `packages/contracts` (copy only), `packages/core`, `packages/adapters` (copy only), `apps/api` (`app.ts`, `routes/context.ts`, mail and messaging text), `apps/web`, `apps/mobile` (including `lib/endpoint.ts` copy), `apps/desktop` (`productName`, setup page, `local-stack.ts` copy), `apps/www`, `infra/compose` and `infra/sandboxes` (installer, alert and desktop-menu text).
- Invariants affected: none. The error text for missing credits changed on the server and in the web run-error mapping together; runs that stored the old text show it unmapped. The desktop `productName` is now VNBot, so the packaged app name and its user-data folder follow it.
- ADR: none

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

## 2026-10-29 — Web without subscription UI and production source maps

- Date: 2026-10-29
- Pull request: pending (local changes; no pull request created)
- What changed versus the baseline: the web client removes subscription gates, credits, billing and wallet panels, and usage prices. Legacy monetization links open General. Protected and unknown routes have explicit session-aware handling. Sign-in keeps the existing passkey client and drops automatic-account and unavailable legal-page promises. Web language choices are Vietnamese and English; other saved catalogs still load. Catalog descriptions remove foreign product names and open-source claims at display time. Production builds disable source maps.
- Why: the web experience uses users' own model connections without a paywall and presents VNBot navigation and copy consistently.
- Modules and files: `apps/web/src/App.tsx`, settings, onboarding, sidebar, auth, integration catalog rendering, locale helpers and unit tests; `apps/web/index.html`; `apps/web/vite.config.ts`; `packages/core/src/run-error.ts`.
- Invariants affected: no API endpoints, shared API types, auth policy, server defaults, data storage, or migrations change. Passkeys reuse the existing auth endpoints. Production assets omit source maps. Locale catalogs are maintained separately.
- ADR: none

## 2026-10-29 — VNBot distribution defaults

- Date: 2026-10-29
- Pull request: none (local commits only)
- What changed versus baseline: published app, computer and updater image defaults and installation repository URLs use `aikingcorp-spec/vnbot`. Offline release fixtures use the same repository. Desktop and shared update mode selection require explicit opt-in; the updater sidecar refuses to start unless `RAKAZO_DISABLE_AUTO_UPDATE=0`, and Compose and environment examples default to `1`. Plugin preview rate-limit errors state the unauthenticated quota; the per-commit cache and optional token remain. Non-provider upstream URLs and temporary brand exceptions are removed; the site catalog has an environment override.
- Why: installs must use the VNBot distribution rather than upstream artifacts, and unpublished releases must not trigger update attempts.
- Modules and files: Compose manifests and examples, installer, Kubernetes sandbox default, desktop updater, shared update mode, plugin preview diagnostics, neutral emulator hosts, navigation parsing, site catalog and competitor citations, updater assertions, setup and self-host documentation.
- Invariants affected: source package identifiers remain Rakazo; sandbox contracts and data storage are unchanged. Frozen baseline documentation is unchanged.
- ADR: [0008 — distribution and update opt-in](adr/0008-distribution-and-update-opt-in.md)

## 2026-10-29 — Remove purchase and cloud launch tools

- Pull request: none (local commits only).
- Changed versus baseline: remove `cloud_agent_launch`, `request_purchase`, and `paid_request` from the shared tool contract, model schemas, labels, and dispatch registrations. Remove the scripted launch fixture and its E2E spec. Existing records and their status/recovery services remain readable.
- Why: bots must not offer cloud launches or purchases as product capabilities.
- Modules and files: `packages/contracts/src/builtin-tools.ts`, adapter tool definitions, selection, dispatch and scripted runtime, web labels and catalogs.
- Invariants affected: these tools cannot be offered to a model or enabled through bot settings; existing storage is unchanged.
- ADR: none (capability removal).

## 2026-10-29 — Vietnamese bot introductions

- Pull request: none (local commits only).
- Changed versus baseline: the creation prompt defaults greetings, onboarding choices and generated profile text to Vietnamese, with Vietnamese examples for general and accounting roles. Explicit user language requests still take precedence.
- Why: a new bot should speak the product's default language from its first message.
- Modules and files: `apps/api/src/routes/bots.ts`, prompt contract assertions in `apps/api/src/router.test.ts`.
- Invariants affected: the existing creation run and restricted tool selection remain shared across clients; no stored messages are rewritten.
- ADR: none (default prompt correction).

## 2026-10-29 — Tool call identities before execution

- Pull request: none (local commits only).
- Changed versus baseline: completed model responses receive unique local IDs for empty, blank or duplicate tool-call IDs before execution and transcript persistence. Valid wire IDs are preserved. Context protocol errors are classified as app context failures with localized retry/new-chat advice.
- Why: a compatible endpoint can omit the wire ID; Pi retains the call with an empty ID and executes it, producing a result with the same empty ID. Context grouping rejects that result on the next model call before trimming. An offline runtime regression reproduces the exact exception with prior messages and a long prompt; message length is not required for the fault.
- Modules and files: `packages/adapters/src/pi-runtime-stream.ts`, runtime regressions, `packages/core/src/run-error.ts`, web run-error translator and catalogs.
- Invariants affected: execution, approvals and persisted transcripts share one call identity; malformed context is still rejected rather than silently discarding action results. No database changes.
- ADR: none (protocol invariant repair).

## 2026-10-29 — Public deployment version

- Pull request: none (local commits only).
- Changed versus baseline: unauthenticated `GET /api/version` returns only `{sha, builtAt}`, with nulls when unavailable and no caching. `GIT_SHA` uses existing environment loading. Docker accepts optional `BUILT_AT` and writes a UTC timestamp file at build time when omitted; environment loading uses that file as fallback.
- Why: deployment verification needs the running revision and image build time through the same web origin.
- Modules and files: `apps/api/src/version.ts`, `app.ts`, `env.ts`, unit tests and `infra/compose/Dockerfile`. Existing web `/api` proxy serves the route unchanged.
- Invariants affected: the version endpoint reads no session, tenant data or database; authenticated routes retain their checks. Existing deployment commands need no new argument.
- ADR: none (deployment metadata endpoint).

## 2026-10-29 — Remove mobile wallet access

- Pull request: none (local commits only).
- What changed versus baseline: mobile removes the Wallet screen, its navigation entries, translations, and the unused `paymentWallet` client RPC member.
- Why: the product no longer offers wallet setup or purchases in its clients.
- Modules and files: `apps/mobile/lib/api.ts`, settings routes, account menu, settings sheet and locale catalogs.
- Invariants affected: this change removes client access only; payment wallet storage, schema and existing data remain intact. Other billing and authentication behavior is unchanged.
- ADR: none (client capability removal).

## 2026-10-29 — Remove wallet RPC surface

- Pull request: none (local commits only).
- What changed versus baseline: remove wallet status, connect and disconnect RPC contracts and handlers, wallet provider metadata from `me`, unused route audit hooks, and wallet setup documentation.
- Why: clients no longer offer wallet setup or purchases, so the node must not keep exposing the abandoned setup API.
- Modules and files: `packages/contracts/src/rpc.ts` and `domain.ts`; `apps/api/src/router.ts`, `app.ts`, `routes/shared.ts`, removed `routes/payment-wallet.ts`, security audit and wallet route regression tests; removed `docs/self-host/payments.md`.
- Invariants affected: `payment_wallets`, its schema, migrations, RLS and existing data are retained without alteration. No data deletion or migration is introduced. Internal purchase recovery and other billing remain unchanged. Removed RPC requests cannot access stored wallets or secrets.
- ADR: none (removal of an unused API surface).

## 2026-10-29 — Vietnamese desktop setup and local stack messages

- Date: 2026-10-29
- Pull request: none (local commits only; imports `b109d7b2`).
- What changed versus baseline: desktop setup connection errors and local stack progress, recovery and failure messages use a shared desktop string catalog. Vietnamese is the default when no OS locale is available; other OS locales use English unless they begin with `vi`. The setup shell and native dialogs use the same selected locale.
- Why: desktop setup and recovery must be understandable in Vietnamese and identify the VNBot distribution consistently.
- Modules and files: `apps/desktop/src/setup-config.ts` (`probeFailureMessage`), `apps/desktop/src/local-stack.ts` (status and failure messages), `apps/desktop/src/strings.ts` (catalog and formatting), `apps/desktop/src/main.ts` (locale selection), setup shell and corresponding unit tests.
- Invariants affected: server validation, connection probes, local Compose orchestration, secret storage and recovery behavior are unchanged. Raw Docker output and internal error details remain outside translated user messages. Auto-update still requires explicit opt-in; source identifiers remain Rakazo. No API, database or migration changes.
- ADR: none (desktop localization).

## 2026-10-30 — Vietnamese server push text and model control-text filter

- Date: 2026-10-30
- Pull request: kai/push-notif-vi (builds on #8).
- What changed versus baseline: server push notification titles and bodies (approval, question, screen, finished, failed, stopped, stuck-work) come from a Vietnamese catalog in `packages/core/src/notification-text.ts`, with tool labels matching the web vi catalog. `run-turn.ts` wraps the runtime event stream in `filterModelControlText`, which drops leaked harmony/channel control tokens and English tool-call retry talk and emits one Vietnamese progress line instead.
- Why: VNBot is Vietnamese-first; English push text and leaked model control tokens reached users.
- Modules and files: `packages/core/src/notification-text.ts`, `model-control-text.ts`, `stuck-work.ts`; `packages/adapters/src/model-control-filter.ts`, `run-turn.ts`, `run-lifecycle.ts`, `run-tool-gate.ts`, `run-routines.ts`, `run-notifications.ts`, `run-tools-secrets.ts`, and unit tests.
- Invariants affected: run state, persisted run errors (still English), approvals and tool execution are unchanged; the filter only removes text, never events other than leaked text, and rethrows runtime errors after releasing held text. No API, database or migration changes.
- ADR: none (localization and output hygiene).

## 2026-10-30 — Sanitize stored bot messages on read; Vietnamese fleet approval cards

- Date: 2026-10-30
- Pull request: #11 (fix round 1).
- What changed versus baseline: thread message pages, reply previews and sidebar previews pass stored bot text blocks through `sanitizeStoredBlocks` (core), which applies the live filter's rules to old rows; fully leaked bot messages are omitted from pages. Fleet tool approval card titles and lines are Vietnamese.
- Why: messages stored before the live filter still showed leaked control tokens and English retry talk.
- Modules and files: `packages/core/src/model-control-text.ts`, `apps/api/src/thread-message-pages.ts`, `packages/db/src/preview-messages.ts`, `packages/adapters/src/fleet-tools.ts`, tests.
- Invariants affected: read-only; no DB rows are rewritten, no migrations. User and system messages are returned as stored. Paging cursors use raw rows.
- ADR: none.

## 2026-10-30 — vnbot.run site is two landing pages; login-code wordmark size

- Date: 2026-10-30
- Pull request: #12 (fix round).
- What changed versus baseline: `apps/www` builds only the Vietnamese landing at `/`, the English landing at `/en/`, a Vietnamese 404 page, `robots.txt`, `llms.txt` and a sitemap with `vi-VN` and `en-US` alternates. The baseline marketing routes, locales, blog, docs, per-route markdown, edge middleware and download redirect are removed, and the built output carries no baseline product name. The login-code email wordmark `<img>` is 107x32 to match the v4 wordmark image (440x131).
- Why: the public site is the approved VNBot landing only; the old image size would stretch the new wordmark.
- Modules and files: `apps/www` (pages, `astro.config.mjs`, `vercel.json`, e2e, removed content), `packages/auth/src/sign-in-code-templates.ts`, `packages/auth/src/index.test.ts`, `packages/ui-tokens` (brand export no longer writes a marketing mark).
- Invariants affected: sign-in code generation, verification and delivery are unchanged; only email markup dimensions differ. The signed-in product, API and database are unchanged.
- ADR: none.
## 2026-10-30 — Add isolated P2P gateway test environment

- Date: 2026-10-30
- Pull request: pending (VNB-014).
- What changed versus baseline: added a workers.dev-only `p2p-test` Wrangler environment with separate D1 and NodeRoom Durable Object bindings.
- Why: provide an isolated deployment target for owner-approved P2P validation without changing existing gateway routes.
- Modules and files: `apps/p2p-gateway/wrangler.toml`, `packages/p2p-prototype/package.json`.
- Invariants affected: production gateway bindings and routes remain unchanged; room topology remains node-hub with no client relay.
- ADR: none.


## 2026-10-30 — Native desktop local node orchestration

- Date: 2026-10-30
- Pull request: none (working tree handoff).
- What changed versus baseline: Linux and Windows select the native local PostgreSQL and utility-process server stack, bypass Docker setup for local startup, write the private web URL, and stop native processes before exit. The migration utility applies SQL without Prisma CLI and preserves Prisma history compatibility. macOS retains Docker. Release resource packaging is pending.
- Why: a local desktop node must run without a separate Docker installation on Linux and Windows.
- Modules and files: `apps/desktop/src/main.ts`, `main-app.ts`, `native-postgres.test.ts`, `native-stack.ts`, `native-services.ts`, `native-migrate.ts`, `native-smoke.ts`, `native-local-stack.ts`, related tests, and `apps/desktop/NOTES-FOR-KAI.md`.
- Invariants affected: data stays on the customer node; migration owner credentials remain separate from the runtime role; RLS, shared UI and existing host-command permissions are retained. Loopback endpoints and private files remain local. Original SQL files and baseline documentation are unchanged.
- ADR: [0009](adr/0009-native-desktop-local-runtime.md).
