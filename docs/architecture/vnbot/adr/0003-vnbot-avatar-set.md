# ADR 0003: Avatar set `vnbot`

Status: **Accepted**

Date: 2026-10-28

## Problem

VNBot bots need a third avatar set, forked from the logo set rather than from the organic renderer. `resolveBotAvatarSet` used to keep only `rakazo` and fold every other value into `organic`. A duplicate or import of a vnbot bot would silently become organic.

## Decision

The contract enum is `organic`, `rakazo`, and `vnbot`. `resolveBotAvatarSet` returns `vnbot` when that is the stored value and still returns `organic` for anything else unknown. New bots created through the API default to `vnbot`. Existing rows keep their stored set. `bots.avatarSet` stays text, so there is no migration.

The vnbot id seed follows the logo set: no organic family, and a non-heart id. Body colour is a stable pick from the twelve palette hexes (la-ma, la-dong, kem-lua, cham-ran, hong-sen, do-son, vang-nghe, xanh-ma, xanh-ngoc, cam-gach, nau-ca-phe, cham). A colour already stored on a bot is not rewritten.

## Consequences

Older clients that do not know `vnbot` still parse the field as invalid or draw the organic fallback. The web renderer for the five mascots is not part of this change. Unknown sets remain `organic`. `organic` and `rakazo` rows are unchanged.
