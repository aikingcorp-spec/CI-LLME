# ADR 0002: Email-code sign-in and a phase-1 invite list

Status: **Accepted**

Date: 2026-10-28

## Problem

VNBot's first sign-in is one path: email, then a 6-digit code. An unknown invited address creates an account. Password sign-in, sign-up, and reset are not part of that path. Passkeys stay. Phase 1 is invite-only.

`passwordAuth: false` is the existing SSO-only switch. It also closes email codes and passkeys and refuses to start without OIDC. It cannot be the switch for this path.

## Decision

`AUTH_EMAIL_CODE_ONLY=true` closes only the password routes: `/sign-in/email`, `/sign-up/email`, `/request-password-reset`, `/reset-password`, `/change-password`, and `/set-password`. Email codes and passkeys stay. The capabilities response reports `passwordAuth: false` so clients hide password surfaces. The refusal code on those routes stays `PASSWORD_AUTH_DISABLED`.

`AUTH_EMAIL_ALLOWLIST=on` reads `auth_email_allowlist`. The check runs before a sign-in code is stored or sent, before a user row is created, and before a session row is created. An address that is not listed gets HTTP 403 `{ "code": "EMAIL_NOT_INVITED", "message": "This email is not invited yet" }` and no email. Every address is normalized the same way in code and in the table's CHECK: trim, Unicode NFC, strip zero-width characters (U+200B, U+200C, U+200D, U+2060, U+FEFF), then lowercase. The code is sent to, and the account stores, the normalized address.

Sending a code is limited per normalized address in addition to per IP: 5 sends per 15 minutes while the list is on, 10 otherwise. The per-address bucket is consumed only for invited addresses (when the list is on); an uninvited address gets 403 `EMAIL_NOT_INVITED` and is limited per IP only, so nobody can exhaust an invited user's bucket by sending codes in their name. With the list off, every address is counted. The limiter runs in every environment while the list is on, not only in production.

The table is system-only under forced row-level security. Reads and writes need `app.rls_bypass`, and the runtime login has no UPDATE grant. Operators change it with the CLI: `pnpm --filter @rakazo/api email-allowlist add|remove|list`. `bootstrap-owner` adds the owner's address.

Removing an address deletes that account's sessions in the same transaction. A session that still exists for an address that is no longer invited is deleted when it is next read. HTTP callers get 401 `EMAIL_NOT_INVITED`.

SSO goes through the same list. When the provider's email is not invited, the OIDC callback answers a bare `302` to `<web origin>/sign-in?error=EMAIL_NOT_INVITED` with `cache-control: no-store`, no cookies, and no user, account, or session row. The `Location` is absolute and built from the configured web origin, never from the request's Host header. An existing invited account is linked to SSO only from Settings while signed in; implicit linking stays off. When the provider's email already belongs to another account, the callback answers a bare `302` to `<web origin>/sign-in?error=ACCOUNT_NOT_LINKED` (no-store, no cookies); the VI/EN copy lives in `@rakazo/contracts` (`AUTH_ERROR_MESSAGES`). With OIDC off, the callback answers 404.

A failed delivery is reported to `onEmailError` as its error class and numeric status only. Provider errors that echo the message, and with it the code, never reach the logs. Turning the flag off restores the previous signup policy and does not require a migration.

A new account whose name is missing or equal to the email stores the local part of the address. An explicit name is kept.

Sign-in code mail uses the Vietnamese template unless the request passes English. The code is not in the subject. Locale travels only on the `x-rakazo-locale` header (`vi` or `en`). Better Auth's send-code body schema drops unknown JSON fields, so a `locale` property on the body is ignored.

## Consequences

A deployment can close passwords without closing codes or passkeys. With the invite list on, deleting a row blocks the next code, the next account, and the next session, including a passkey on an existing account, and signs that account out everywhere. The 403 says whether the address is invited. It does not say whether an account exists. The send path is limited to 5 sends per 15 minutes per address and per IP while the list is on. Threads, runs, and vault rows are unchanged.
