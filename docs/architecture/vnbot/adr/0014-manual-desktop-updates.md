# ADR 0014: Manual desktop updates through a public feed

Status: **Accepted**

Date: 2026-11-03

## Problem

The desktop opt-in gate introduced before the first release also prevents an
explicit Check for updates action. Published installers have no update provider
configuration. A private source repository cannot serve an unauthenticated
GitHub update feed to customers.

## Decision

Packaged desktop applications allow explicit in-app checks independently of the
background preference. Scheduled checks still require
`RAKAZO_DISABLE_AUTO_UPDATE=0`. Unpackaged development applications remain unsupported.
The existing IPC controller, download progress, restart/install action, operation
serialization and upgrade-only policy remain the update path.

Package a generic HTTPS feed at the public download origin. Publish immutable
versioned artifacts first and mutable latest metadata only after verification.
Packaging checks compare feed versions, file sizes and SHA-512 digests with the
actual installers. Do not place repository credentials in the desktop application.

Keep SDK integrity checks and publisher verification when a signing publisher is
configured. The existing unsigned Windows distribution can use manual NSIS updates
without inventing a publisher or disabling signature checks globally. macOS signing
and notarization requirements remain separate. The signed-release workflow retains
its signing requirements.

This supersedes only the desktop manual-check gate in ADR 0008. Sidecar updates,
their token, profile and explicit opt-in remain unchanged.

## Consequences

Users can check, download and install updates inside a newly packaged application.
Already installed applications whose native code blocks all update checks cannot
be repaired merely by publishing a feed. They need a one-time native upgrade or
an existing, explicitly supported local configuration path; no remote command or
unverified installer execution endpoint is added to bypass that limitation.

Rollback retains all previous installers and feed metadata. Do not replace a
versioned installer, force a downgrade or restore a production database.
