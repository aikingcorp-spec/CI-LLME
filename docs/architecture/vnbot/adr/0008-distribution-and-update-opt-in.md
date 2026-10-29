# ADR 0008: VNBot distribution and explicit update opt-in

Status: **Accepted**

Date: 2026-10-29

## Problem

Upstream images and installation links do not identify the VNBot distribution. No official
VNBot release is available yet, so automatic update attempts must stay off by default.

## Decision

Default app, computer and updater images use `ghcr.io/aikingcorp-spec/vnbot`; repository
links use `github.com/aikingcorp-spec/vnbot`. Existing operator image overrides remain.
Source package names, protocols and storage identifiers remain Rakazo.

Desktop update support and shared update execution require explicit opt-in. The desktop
composition root and the updater sidecar treat only `RAKAZO_DISABLE_AUTO_UPDATE=0` as opt-in.
The sidecar also retains its opt-in Compose profile and dedicated token requirement.
Environment examples and Compose default this setting to `1`. An official release must
exist before operators enable release-based updates; publishing one does not silently
change an installed deployment's settings. No credentials are bundled.

## Consequences

Source builds continue to work before images are published. Operators can upgrade manually.
The application API has no self-update endpoint and does not receive updater credentials.
No database migration is needed. Bot instruction updates remain a separate setting, already
off by default. Desktop updates keep signature verification and explicit download/install.
