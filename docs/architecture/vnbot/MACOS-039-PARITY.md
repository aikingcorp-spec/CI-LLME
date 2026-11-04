# macOS Universal native candidate, 0.3.9

Status: implementation and verification in progress. Not a published release.
Baseline: source commit c1b53a39ba6a9518f753e200920855ee542fc415.

## Scope and dependency audit

Reuse NativeStack, NativePostgres and Electron utility processes. No engine,
RPC, provider, auth or P2P protocol changes. Preserve app ID, userData and
PostgreSQL layout. Explicit Docker override remains supported. macOS now
selects native by default; existing Docker data is not automatically migrated
into PostgreSQL. An existing Docker installation must retain its explicit
runtime choice until a separately verified data migration is available.

| Module | Change | Dependency / risk | Protection |
| --- | --- | --- | --- |
| stack-runtime | Native default on Darwin | Packaged server and database must exist | Runtime selection tests, actual cold start |
| desktop package | Darwin PostgreSQL x64 and arm64; native server and migrations | Optional packages must be installed for both CPUs | Frozen lockfile; packaged inventory and startup |
| build.mjs | Stage both Darwin CPU optional dependencies | Shared extraResources must support both Electron slices | Fail on missing sharp/libvips/koffi/Postgres packages; addon loads on both CPUs |
| after-pack | Resolve actual .app/Contents/Resources | Library symlinks must remain within package | Existing escape tests plus both Darwin package fixtures |
| macOS CI | Separate candidate build and two CPU verification jobs | Runner arch must match; no Windows/Linux jobs or publication | uname assertions; identical archived Universal app consumed by both jobs |

Native dependencies: Electron executable/frameworks and node-datachannel must
contain both slices after merging. PostgreSQL executables/dylibs, sharp/libvips,
koffi and parser bindings may remain thin only in explicit CPU-selected package
paths. The inventory records every packaged Mach-O and checks all symlinks.
No Linux or Windows binary may substitute for a Darwin dependency.

## Feature parity and evidence gates

Windows/Linux behavior is the unchanged baseline, not re-certified by this port.
"Shared" below means the source is reused, not that a live integration passed.

| Feature | Windows/Linux baseline | macOS source path | Mac runtime evidence required |
| --- | --- | --- | --- |
| Startup, shutdown, persistence | Native stack | Same NativeStack/Postgres/services | Two launches, preserved DB, no leftover processes on each CPU |
| Crash recovery | Existing lifecycle and child restart | Shared | Host/child crash and restart; not yet verified |
| Account, provider auth, routing | Existing 0.3.9 | Shared; same local session | Real account/provider test; pending |
| Provider CLI | Optional user-selected installation/auth | Shared discovery | Each supported CLI on each CPU; pending |
| Sessions/history | Native PostgreSQL | Same migrations/RLS | Persistence and live transcript; pending |
| Agent/tools/workspace | Native desktop sandbox | Shared POSIX process/file implementation | End-to-end tool run and file containment; pending |
| MCP/marketplace | Existing integrations | Shared popup policy/server | Packaged OAuth fixture plus real configured connector; pending |
| Pairing, RPC, chat, streaming | Existing P2P implementation | Same node-datachannel/protocol | Live browser to packaged host; pending |
| ICE/TURN/reconnect/revocation | Known existing limitations | Unmodified | Real relay, network switching and revoke; pending |
| Voice/microphone | Existing voice adapter | Shared with audio-input entitlement | Real permission prompt and call; pending |
| Screen/control | Host computer integration | Existing adapters, no replacement | Screen Recording and Accessibility, real capture/input; pending |
| Updates/rollback | Existing platform updater | Existing macOS updater | Signing, update/install, data retention; pending |
| Distribution | Existing platform installers | Universal DMG/ZIP candidate | Clean Mac install/Gatekeeper; pending |

Known P2P defects from the separate audit are not repaired by this packaging
change. Do not describe a passing binary load or health check as P2P parity.

## Release gates and rollback

CI template: deploy/ci/desktop-macos-039.yml, installed only in CI-LLME.
Ad-hoc signed candidates explicitly disable notarization for the CI artifact only;
they are not approved for public distribution. No security bypass instructions
are part of the product. Trusted signing/notarization, clean-machine Gatekeeper,
actual peripherals/permissions and complete feature parity remain gates.
Do not merge, publish feeds, upload public installers or change landing until
the required evidence exists. Preserve Windows/Linux metadata and artifacts.

Source rollback is removal of these Mac packaging changes. Candidate runs never
mutate production. If a Mac candidate has been installed, retain its application
data and restore the previous application; never reset a database as rollback.


## Marketplace verification added

On each Mac CPU, the candidate database backs browser suites for marketplace
installation/removal, skill packs, direct MCP, personal Composio setup and
OAuth callbacks. Existing emulators/fake providers are used; these do not certify
Google, Stripe or another live vendor. Packaged Electron popup isolation runs
separately. The native P2P RPC integration also creates/lists a personal MCP
server and reads integration setup over the DataChannel, checking that secrets
are not returned. This does not yet certify vendor OAuth callback delivery over
an Internet P2P connection. Live vendor credentials remain a release gate.


## Build issue found through macOS execution

The pinned node-datachannel 0.32.0 upstream release supplies a Darwin arm64
prebuild, but no Darwin x64 prebuild. electron-builder reused the installed ARM
addon in both temporary app bundles, so Universal merging correctly failed.
Do not whitelist this shared-path addon as a thin binary. Compile its unchanged
source on an Intel runner with a locked build toolchain, combine Intel and ARM
addons with lipo, and require both slices in the final artifact. No library or
protocol replacement is involved. This compile path is pending verification.
