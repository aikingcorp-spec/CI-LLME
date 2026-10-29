# ADR 0003: Web sign-in is email, then a code

Status: **Accepted**

Date: 2026-10-28

## Problem

The web auth page asked for a password, a name, and a separate sign-up. VNBot's first screen is one flow: email, then a 6-digit code. An address that is not on the invite list must see the limited-preview panel instead of a code.

## Decision

The web client (`apps/web/src/pages/Auth.tsx`) has two steps, `email` and `code`. `/sign-up`, `/forgot-password`, and `/reset-password` redirect to `/sign-in` (keeping `?next` on sign-up). Passkey stays a text line under the email step. Typed codes render as dots. The value stays in the one-time-code field so it can be submitted, and it is not written into visible text or logs.

The auth server already returns errors as `{ code, message }` (HTTP status from Better Auth's `APIError`). Not-invited is HTTP 403 with `code: "EMAIL_NOT_INVITED"` and `message: "This email is not invited yet"`, on both the send-code request and user creation. The client reads `error.code`, the same field it uses for `PASSWORD_AUTH_DISABLED` and `INVALID_OTP`. The constant is `EMAIL_NOT_INVITED` in `apps/web/src/lib/user-error.ts`.

The send-code body schema drops unknown fields, so the UI locale travels on the request header `x-rakazo-locale` (`vi` or `en`). Any other active locale sends `en`.

This pull request does not add the allowlist table or the server hook. Kai's auth server is the writer of `EMAIL_NOT_INVITED`. Until that hook exists, the panel appears only when a response actually carries the code.

## Consequences

Password fields are gone from the web sign-in page. Password change inside account settings is unchanged. Servers that offer only SSO still show the SSO button and hide the email form. A deployment that has passwords but no email codes will show the email form anyway; sending a code then fails with the server's error.
