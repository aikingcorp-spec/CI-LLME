# ADR 0015: macOS Universal uses the existing native runtime

Status: Accepted for implementation; public distribution gated by runtime evidence.
Date: 2026-11-04.

Extends ADR 0009's platform coverage. macOS defaults to the existing NativeStack,
Electron utility processes and embedded PostgreSQL, with both Darwin CPU variants
included in one Universal application. Shared server JavaScript uses the existing
architecture-selecting sharp/koffi packages. Do not introduce another engine or
substitute a foreign operating system's binaries. Retain explicit Docker opt-in,
app identity and user data locations. No automatic Docker database migration is
part of this decision; existing Docker users require an explicit runtime choice.

Build and test only macOS in CI-LLME, preserving version 0.3.9 and other platform
artifacts. The same final app must run on Intel and Apple Silicon. Packaging,
addon load and health checks do not prove P2P, permissions or feature parity.
See ../MACOS-039-PARITY.md for evidence and publication gates.
