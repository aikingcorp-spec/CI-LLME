# Run evidence

Redacted records of the netns runs described in the package README. Each run executes the whole vitest file
(`src/two-machine.netns.test.ts`, 3 tests): the NAT probe test (NAT folders) or the wire-level forwarder
assertion (TURN folders), the restart test, and the node-initiated close test. The counts below are derived
by script from each folder's `RESULTS.txt` and the number of `runs/run-NN.txt` files, not typed by hand.

| folder | what ran | runs | passed | failed |
|---|---|---|---|---|
| `nat-cone/` | real kernel NAT, cone (port-restricted), ICE policy all | 20 | 20 | 0 |
| `nat-symmetric/` | real kernel NAT, symmetric (--random-fully), ICE policy all | 20 | 20 | 0 |
| `turn-tcp/` | TURN over TCP, relay-only, clean rerun at low load | 20 | 20 | 0 |
| `turn-tcp-under-load/` | TURN over TCP, relay-only, run while the box load average was 87 to 109 | 20 | 18 | 2 |
| `turn-tls/` | TURNS over TLS, relay-only | 20 | 20 | 0 |

Each folder holds:

- `RESULTS.txt`: one line per run, as the loop that drove the runs produced it. NAT lines carry the number of
  selected pairs, the candidate types, host-to-host pairs (always 0) and the mapping the NAT probe measured
  for peer A and peer B. TURN lines carry the number of selected pairs and `channel_open` events that were
  relay candidates on the TURN host with the expected `turnTransport`, the TCP connections and bytes the
  forwarder counted, and the UDP datagrams toward the TURN ports (always 0).
- `runs/run-NN.txt`: the vitest summary, the NAT probe result (NAT folders), the forwarder's final wire
  counters (TURN folders), the selected ICE pair of every session as `type address:port` (relay candidates also show their
  `raddr`), with `turnTransport` and a check that the `channel_open` event carried the same pair, and the event counts of each process log. Failed runs also list their `connect_failed`
  events.

Notes:

- `nat-cone/` and `nat-symmetric/`: peers sit on the same private subnet behind separate router namespaces
  doing kernel NAT; the STUN server is local to the emulated internet, so the `srflx` addresses are the
  routers' `10.78.3.x` addresses. Cone runs select `srflx` to `srflx`; symmetric runs select `relay` to
  `relay` on the TURN host. TURN over the box's real uplink was reached through the L4 forwarder.
- `turn-tcp/`, `turn-tcp-under-load/`, `turn-tls/`: routed topology (no NAT) with the test-only werift peer
  `turn-tls/` run-04 timed out on its first attempt and passed on reconnect; `runs/run-04.txt` records `close-client {"ts": "2026-10-30T01:25:08.076Z", "event": "connect_failed", "error": "timed out"}`, followed by reconnect `channel_open` events.
  connection. `turn-tcp-under-load/` is an earlier TURN/TCP batch run while the box was heavily loaded; its
  failed runs are kept as failures and were not retried or replaced. `turn-tcp/` is the clean rerun of the
  same batch.
- Redaction: every IPv4 or IPv6 address that is not private (`10/8`, `172.16/12`, `192.168/16`), loopback or
  unspecified (`127/8`, `0.0.0.0`) or the TURN server itself is replaced with `<box-public-ip>`; this covers
  the `raddr` of relay candidates. No TURN username or credential, no local paths, and no process-log text
  other than the fields listed above are included. Process ids are from the runs and carry no meaning.
- Size on disk (bytes): `nat-cone` 56771, `nat-symmetric` 57099, `turn-tcp` 57526, `turn-tcp-under-load` 56141, `turn-tls` 57848.
