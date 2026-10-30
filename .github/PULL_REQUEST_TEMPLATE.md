## Why

## What

## How tested

## Architecture trail

See the section "Architecture trail rule" in AGENTS.md. The sensitive paths are listed in `scripts/architecture-trail.config.json`.

- [ ] This pull request does not touch those paths.
- [ ] It does, and `docs/architecture/vnbot/CHANGELOG-ARCHITECTURE.md` has a new entry (date, pull request, what changed versus the baseline, why, modules and files, invariants affected, ADR link).
- [ ] It is a decision, and there is a new ADR under `docs/architecture/vnbot/adr/`. Otherwise leave this unchecked.
- [ ] `docs/architecture/vnbot/ban-do-vnbot.md` is updated, or the owner-facing picture did not change.
- [ ] `docs/architecture/rakazo-baseline/` is untouched. A typo-only edit uses the label `baseline-typo`.

A sensitive diff that is not an architecture change needs the label `no-arch-change` and this line in the description:

Architecture-trail-justification: 
