# ADR 0006: Language switch and reload-safe step on sign-in

Status: **Accepted**

Date: 2026-10-29

## Problem

Signed-out visitors land in Vietnamese (ADR 0004) and before this change could only switch language from Settings, after signing in. Reloading the page during the code step sent people back to the email step, and they had to request a new code. The not-invited contact link was hard-coded in `Auth.tsx`.

## Decision

- `apps/web/src/components/LanguageSwitch.tsx` is a compact vi/en menu (Base UI radio items through `@rakazo/ui-web` `DropdownMenu*`). It calls `setUiLocale`, the same function Settings uses, so `rakazo.uiLocale` remains the only saved key. A request id makes the last click win. Welcome renders it at the end of the header. `AuthFrame` renders it at the top end, outside the `<form>`, so choosing a language never submits the form (email-otp spec §6.2–6.3).
- `apps/web/src/lib/sign-in-progress.ts` saves `{ email, step, sentAt }` under `sessionStorage["vnbot.signIn"]` when a code is sent. It restores the code step on mount when the send is less than 10 minutes old, and resumes the resend countdown from `sentAt`. It clears the entry on sign-in. The code itself is never stored. `sessionStorage` scopes the entry to the tab, so it does not outlive the tab or leak to other tabs.
- `apps/web/src/lib/vnbot-links.ts` exports `VNBOT_CONTACT_URL` from `VITE_VNBOT_CONTACT_URL`. Only `https:` values are accepted; anything else falls back to `https://aikingx.com`.
- The email input sets `aria-invalid` after a failed validation and points `aria-describedby` at the error.

## Consequences

The switch is visible on every signed-out screen. It offers only vi and en; Settings still lists every locale. A visitor whose locale is one of the others sees the switch without a checked item until they pick one. A reload during the code step keeps the step without sending a new code. Opening a new tab starts at the email step.
