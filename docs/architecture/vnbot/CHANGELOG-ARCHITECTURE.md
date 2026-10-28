# Architecture changelog

Each entry is a change versus the frozen Rakazo baseline at commit `c4b24547` (`docs/architecture/rakazo-baseline/SYSTEM_MAP.md`). Record the date, what changed, why, which files or modules moved, which invariants moved, and the ADR or PR.

Proposed decisions are listed so reviewers can see them. They do not change the running system until a later entry says they landed in code.

## 2026-10-28 — No architecture change yet

- What changed versus baseline: nothing in code or data. Clients still call one Rakazo HTTP origin. A wrong draft of ADR 0001 (screen sharing over WebRTC) was discarded before implementation.
- Why: VNBot will be a hosted gateway at vnbot.run plus a self-hosted node (the full stack on the customer's machine). The gateway signs people in, lists nodes, and helps them connect. Chat stays on the node. The connection should become a WebRTC data channel, with TURN only as fallback.
- Files / modules: documentation only. `docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md` (status Proposed) names the gateway, the node agent, and a `ClientTransport` seam in front of today's `/rpc` and `/api/auth` calls. No module moved.
- Invariants affected: none. The node's thread ownership, run lease, RLS, and approval gate are unchanged. The gateway must not become a second store for those rows.
- Links: [ADR 0001](adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md), pull request https://github.com/aikingcorp-spec/vnbot/pull/1
