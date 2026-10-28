# ADR 0002: Email-code sign-in and a phase-1 invite list

Status: **Accepted**

Date: 2026-10-28

## Problem

VNBot's first sign-in is one path: email, then a 6-digit code. An unknown invited address creates an account. Password sign-in, sign-up, and reset are not part of that path. Passkeys stay. Phase 1 is invite-only.

`passwordAuth: false` is the existing SSO-only switch. It also closes email codes and passkeys and refuses to start without OIDC. It cannot be the switch for this path.

## Decision

`AUTH_EMAIL_CODE_ONLY=true` closes only the password routes: `/sign-in/email`, `/sign-up/email`, `/request-password-reset`, `/reset-password`, `/change-password`, and `/set-password`. Email codes and passkeys stay. The capabilities response reports `passwordAuth: false` so clients hide password surfaces. The refusal code on those routes stays `PASSWORD_AUTH_DISABLED`.

`AUTH_EMAIL_ALLOWLIST=on` reads `auth_email_allowlist`. The check runs before a sign-in code is stored or sent, before a user row is created, and before a session row is created. An address that is not listed gets HTTP 403 `{ "code": "NOT_INVITED", "message": "This email is not invited yet" }` and no email. The table is system-only under row-level security. Operators change it with the `email-allowlist` CLI. Turning the flag off restores the previous signup policy and does not require a migration.

A new account whose name is missing or equal to the email stores the local part of the address. An explicit name is kept.

Sign-in code mail uses the Vietnamese template unless the request passes English. The code is not in the subject. Locale travels on the `x-rakazo-locale` header (`vi` or `en`). Better Auth's send-code body schema drops unknown JSON fields, so a `locale` property on the body is not the contract.

## Consequences

A deployment can close passwords without closing codes or passkeys. With the invite list on, deleting a row blocks the next code, the next account, and the next session, including a passkey on an existing account. The 403 says whether the address is invited. It does not say whether an account exists. The send path is limited to 5 requests per 15 minutes per IP while the list is on. Threads, runs, and vault rows are unchanged.
