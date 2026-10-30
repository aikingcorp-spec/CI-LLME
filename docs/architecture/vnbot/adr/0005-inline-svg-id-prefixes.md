# ADR 0005: Inline SVG ids are prefixed per instance

Status: **Accepted**

Date: 2026-10-28

## Problem

The five mascot SVGs each declare `id="eye"` and other shared ids, and Rằn's scarf uses `url(#gingham)`. A page that inlines more than one of them (the welcome row, or a sidebar of bots) makes those ids collide, so `<use>` and the pattern paint the wrong shape.

## Decision

Components inline the SVG with `dangerouslySetInnerHTML` (the files are static brand assets) and run `prefixSvgIds` (`packages/ui-web/src/svg-ids.ts`) with a prefix from React `useId()`. The helper rewrites `id`, `href`, `xlink:href`, and `url(#…)`. Wordmarks are `<img>` files, one per theme, so they never share a document with those ids.

Bot art for `avatarSet: "vnbot"` uses the same helper. The set is accepted by the avatar contract. The default for new bots stays `"rakazo"` in this change: mobile has no mascot renderer yet, and flipping the default would draw organic bodies on those phones and change the logo motion the web already tests. A later change can set `DEFAULT_NEW_BOT_AVATAR_SET` to `"vnbot"` once mobile draws the set.

## Consequences

Welcome and any number of VNBot avatars can sit on one page. Ids are unique per mount. The mascot for a bot is `hash(id) % 5`. A studio control to pick the mascot is not in this change.
