# ADR 0004: Vietnamese is the default web locale

Status: **Accepted**

Date: 2026-10-28

## Problem

The web UI shipped English as the default. VNBot's first audience reads Vietnamese.

## Decision

`vi` is a Lingui locale (`apps/web/lingui.config.ts`, `apps/web/src/lib/i18n.ts`, `apps/web/src/lib/ui-locale.ts`). The picker lists it first, labeled `Tiếng Việt`. Source messages stay English.

`VITE_DEFAULT_UI_LOCALE=vi` is set in `.env.example`, `apps/web/.env.development`, and `apps/web/.env.production`. `resolveUiLocale` is unchanged: a saved `rakazo.uiLocale` wins, then this variable, then the browser language, then English. Playwright sets the variable to `en` so existing selectors keep matching source messages.

The shared core fallback stays English. Mobile locales are unchanged.

## Consequences

A fresh web session is Vietnamese. Choosing English in settings still stores `rakazo.uiLocale` and sticks. Strings without a Vietnamese translation fall back to English.
