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

## Update — 2026-10-29

The web resolution order is now saved `rakazo.uiLocale` → valid optional `VITE_DEFAULT_UI_LOCALE` override → `vi`. Missing or unsupported env values fall back to Vietnamese; browser language never participates. Saved-choice normalization is unchanged, and Playwright keeps its English env override.

The Compose Dockerfile builds the web app, but `.dockerignore` excludes `.env.*`, so `apps/web/.env.production` never reaches that build. Relying on its Vietnamese setting let English browsers receive English. The Vietnamese fallback now lives in the resolver itself.
