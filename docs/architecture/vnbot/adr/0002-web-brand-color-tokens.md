# ADR 0002: Web brand color tokens

Status: **Accepted**

Date: 2026-10-28

## Problem

The web and Electron UI used an ink primary. VNBot's brand is an olive green. Mobile follows the iOS system palette and must not pick up the web brand.

## Decision

`webLightOverrides` and `webDarkOverrides` in `packages/ui-tokens/src/index.ts` set the web primary, hover, disabled, foreground, ring, link, and sidebar accent. Light primary is `#6D7C3D` (the nearest shade to the brand green that passes WCAG AA with white text). Dark primary is `#93A460` with `#10140A` text. Links are `#4A5A1F` in light and `#B4C384` in dark. Selected sidebar rows use a green tint (`#6D7C3D2E` light, `#93A46029` dark).

`darkTokens` and `lightTokens` are unchanged. `pnpm --filter @rakazo/ui-tokens generate` rewrites `tokens.css` from those overrides. The body palette (`--vnbot-body-*` and accessory ink) is a separate stylesheet, `packages/ui-web/src/vnbot-palette.css`, imported only by the web component styles.

## Consequences

Web and Electron buttons, focus rings, links, and the selected sidebar row turn green. Mobile colors do not. Chat warning color is not part of this change.
