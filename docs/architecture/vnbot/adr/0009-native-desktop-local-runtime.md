# ADR 0009: Native local runtime for Linux and Windows desktop

- Date: 2026-10-30
- Status: Accepted for source implementation; release resource packaging pending.

## Context

A desktop local node must start without requiring a separately installed Docker engine on Linux and Windows. It must retain the same API, worker, database, sandbox interfaces, and permission settings as the existing product.

## Decision

Linux and Windows default to an app-owned PostgreSQL 16 cluster and Electron utility processes for migrations, API, and worker. macOS keeps the Docker path; the runtime override remains available. Migrations execute ordered original SQL files in per-file transactions with Prisma-compatible history and original SHA-256 checksums. Concurrent indexes build synchronously before application clients start. Top-level transaction wrappers are removed without changing quoted or procedural bodies. A utility process uses the shared role provisioning code and existing Graphile migration dependency after schema migrations.

The app serves the shared web build over loopback, proxies API traffic, and stores the private web URL under its user data directory. Native processes stop before app exit. Smoke mode checks API health and reports a fixed sanitized result before stopping. Chat stays on the customer's node.

## Consequences

Release packaging must supply PostgreSQL platform binaries, migrations, built server entries, generated Prisma runtime resources, and the existing database and queue dependencies. This change does not edit build configuration or dependency manifests; the required handoff is documented in `apps/desktop/NOTES-FOR-KAI.md`. Until those resources are supplied, this is not an installable native release.

RLS and separate migration/runtime credentials remain enforced. No host-command permission, approval workflow, provider contract, gateway storage, or frozen baseline changes are introduced.
