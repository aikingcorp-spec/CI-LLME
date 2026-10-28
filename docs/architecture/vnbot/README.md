# VNBot architecture layer

Read the frozen Rakazo import first, then only the deltas in this folder.

1. Baseline, commit `c4b24547`, never edited except for a typo:
   - Agents: `docs/architecture/rakazo-baseline/SYSTEM_MAP.md`
   - Owner (Vietnamese): `docs/architecture/rakazo-baseline/ban-do-rakazo-goc.md`
2. This folder is the living VNBot layer on top of that tree:
   - `CHANGELOG-ARCHITECTURE.md` — what changed versus the baseline, one entry per change.
   - `adr/` — decisions. `adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md` is Proposed. It is not a baseline edit.
   - `ban-do-vnbot.md` — Vietnamese picture of VNBot as baseline plus those deltas.

A delta is real only after a changelog entry. An ADR with status Proposed is a plan, not a change to the running system. Do not copy a delta back into `docs/architecture/rakazo-baseline/`.
