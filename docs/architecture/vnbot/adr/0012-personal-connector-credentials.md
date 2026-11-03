# ADR 0012: Personal broker credentials and node-bound MCP callbacks

Status: Accepted

Date: 2026-11-02

## Decision

Composio is optional and uses each member's own project key. Do not fall back to
deployment or other members' keys. Manual MCP remains independent of broker setup;
existing Pipedream operator configuration is unchanged.

Store encrypted configuration in `user_integration_provider_configs`, keyed by user
and provider, with row-level security. API and worker resolve the authenticated actor
on every operation. SDK sessions and toolkit directories are credential-owner scoped.
Never return keys or insert them into agent conversation text.

Serialize key replacement with connection changes and refuse replacement while
connections are active. Load prepared credentials outside connection transactions
and recheck their reference inside them. This preserves slow external secret-store
support and fences concurrent credential replacement.

New-tab OAuth callbacks reconnect to their originating paired node before product
RPC. Persist only expiring account/node routing metadata, never codes or tokens.
The node validates state, PKCE and ownership. Completion messages identify the
attempt. Hosted account services do not acquire a product HTTP fallback.

Registry repository metadata describes provenance rather than the connected service.
Neutral plugins can be previewed from registry repositories while actual service
names and functional endpoints retain policy checks. Display sanitization stays separate.

## Consequences

The table migration is additive; previous releases ignore it. Existing global keys
are retained but not silently assigned to members. Installing skills, authenticating
accounts, discovering usable tools and granting bot access remain separate operations.

Tests cover cross-user isolation, missing-key behavior, external secret rotation,
credential fencing and callback routing. Mock tests alone do not certify live OAuth.
