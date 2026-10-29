# ADR 0007: New bots default to the VNBot mascot

Status: **Accepted**

Date: 2026-10-29

## Problem

The 2026-10-28 change accepted the `vnbot` avatar set but kept `rakazo` as the default. Pull request #2 then made `vnbot` the default in the shared contract and added `seededVnbotBodyColor`. This pull request had its own `seededVnbotBodyColor` and palette in `packages/core/src/vnbot-palette.ts`, with a different hash seed. After both merge, `@rakazo/core` would export the name twice, and one bot could get two colors.

## Decision

- Pull request #2 owns the contract: `DEFAULT_NEW_BOT_AVATAR_SET = "vnbot"` (`packages/contracts`), the db default (`packages/db`), and `seededVnbotBodyColor` (hash `vnbot-body/v1/${id}`) over `vnbotBodyColors` from `@rakazo/ui-tokens`. This pull request takes those files as pull request #2 has them and does not redefine them.
- `packages/core/src/vnbot-palette.ts` keeps only `VnbotBodyTone` and `vnbotBodyTone(hex)`. The tone is derived from `vnbotBodyColors`, so there is one palette.
- The create-bot dialog seeds the preview color with `seededVnbotBodyColor` when the default set is `vnbot`, so the preview matches what the server stores.

## Consequences

This pull request must merge after pull request #2, or be rebased onto it. After the rebase, the contract files are no-ops. Existing bots keep their stored set and color.
