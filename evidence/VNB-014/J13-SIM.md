# J13 simulation

Date: 2026-10-31 (UTC+7)

| Path | Ran | Result | Runs | Evidence |
|---|---:|---|---:|---|
| Loopback harness | yes | pass | 1 | `J13-loopback.log`; 2 passed, 2 skipped; 6.83s |
| Kernel NAT cone | no | blocked: no `iptables`; harness check reports this, and apt install failed on unsigned/500 Debian metadata | 0 | `J13-cone.log` |
| Kernel NAT symmetric | no | same missing-iptables blocker | 0 | `J13-symmetric.log` |
| Relay-only coturn | no | blocked: coturn could not be installed after the apt failure; no TURN server/credentials available | 0 | no relay run |
| Wrangler local gateway health | yes | pass | 1 | `wrangler-local.log`, `wrangler-smoke.log`; `/healthz` 200 |

The two-machine test starts an in-process gateway and has no target override for Wrangler, so peer signaling was not routed through Wrangler. The Wrangler smoke verifies local worker startup only. No plaintext canary was sent; captured logs contain no canary. Cleanup stopped Wrangler and ran NAT teardown; no test namespaces remain.
