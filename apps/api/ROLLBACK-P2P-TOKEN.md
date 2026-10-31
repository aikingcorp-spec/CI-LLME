# VNB-022 app-issued P2P tokens prod rollback

Use the confirmed VPS Compose context, protected evidence, `.env.bak-<ts>`, and previous API image ID from [RUNBOOK-P2P-TOKEN.md](RUNBOOK-P2P-TOKEN.md). Apply only the steps reached, in reverse order: 4, 3, 2, 1.

> Never print private keys, cookies, bearer tokens, assertions, or environment values. Run `set +x`. Each rollback step needs its own explicit owner (sếp) approval. Stop on a failed verify and escalate; do not improvise destructive recovery. Merge history and deleted smoke rows cannot be erased or restored by this rollback.

Keep `vnbot-app`, `vnbot-app-auth`, the `app.vnbot.run/api/auth/*` route, DNS, D1 schema, and NodeRoom unchanged. Never delete `GATEWAY_PRIVATE_KEY`, the Worker, or the DO class. Keep workers.dev and preview URLs disabled.

## Verify guard

Run after every rollback step in the confirmed Compose project:

```sh
docker compose ps
test "$(curl -sS -o /dev/null -w '%{http_code}' https://app.vnbot.run/api/auth/ok)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' https://p2p.vnbot.run/healthz)" = 200
TOKEN_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST https://app.vnbot.run/api/auth/p2p-token -H 'Content-Type: application/json' --data '{"scope":["pair"]}')
test "$TOKEN_STATUS" = "$EXPECTED_TOKEN_STATUS"
```

Expect API running without restart churn. Use `EXPECTED_TOKEN_STATUS=401` while the signer remains enabled after steps 4 and 3. Use `404` after steps 2 and 1. If the signer was never enabled, use `404` throughout.

## Step 4: remove leftover smoke rows

Obtain approval. **IRREVERSIBLE:** smoke rows already deleted cannot be restored. There is nothing to roll back except removing leftover smoke rows. Unpair the disposable node first if the service still works, then close smoke signaling connections.

Use only the primary keys captured during smoke. Show SELECT first, review it privately, then obtain cleanup approval before DELETE. Repeat for each recorded jti. Never select or delete another user's rows.

```sh
wrangler d1 execute vnbot-p2p-d1 --remote --command "SELECT node_id, revoked_at FROM nodes WHERE node_id = '<smoke-node-id>'; SELECT jti, exp FROM used_jti WHERE jti = '<smoke-jti>'; SELECT code_hash, expires_at FROM pair_codes WHERE code_hash = '<smoke-code-hash>';"
# IRREVERSIBLE
wrangler d1 execute vnbot-p2p-d1 --remote --command "DELETE FROM nodes WHERE node_id = '<smoke-node-id>'; DELETE FROM used_jti WHERE jti = '<smoke-jti>'; DELETE FROM pair_codes WHERE code_hash = '<smoke-code-hash>';"
wrangler d1 execute vnbot-p2p-d1 --remote --command "SELECT count(*) FROM nodes WHERE node_id = '<smoke-node-id>'; SELECT count(*) FROM used_jti WHERE jti = '<smoke-jti>'; SELECT count(*) FROM pair_codes WHERE code_hash = '<smoke-code-hash>';"
```

Expect 0 for each selected count. Run the verify guard. Shred temporary smoke credentials and node keys after cleanup. Do not remove the protected environment backup yet.

## Step 3: reject app tokens at the gateway

Obtain approval. Deploy the known-good pin at 100%, without uploading new code:

```sh
wrangler rollback ee32c12c-1844-42e9-af4f-8bc1714df2dc --name vnbot-p2p-gateway -m "VNB-022 disable app tokens"
wrangler deployments list --name vnbot-p2p-gateway > "$EVIDENCE/gateway-rollback-deployments.txt"
wrangler versions view ee32c12c-1844-42e9-af4f-8bc1714df2dc --name vnbot-p2p-gateway --json > "$EVIDENCE/gateway-rollback-version.json"
sha256sum "$EVIDENCE/gateway-rollback-version.json"
```

Verify privately that the pin is active at 100% and `APP_TOKEN_PUBLIC_KEYS` is `"{}"`. Record names and fingerprints only. If pinning is unavailable, use the approved version-edit flow on the same pinned code with `APP_TOKEN_PUBLIC_KEYS="{}"`, preserving other bindings. Record the replacement version ID and verify it is active at 100%.

With an empty key map, all app tokens are rejected for new authenticated requests. This does not promise termination of existing signaling sockets or invalidate gateway assertions already issued. Do not delete DO state to terminate them.

Verify rejection using a fresh app token in a mode-600 curl config (`REJECT_CURL_CONFIG`) containing its Authorization header, never a token on the command line:

```sh
test "$(curl -sS -K "$REJECT_CURL_CONFIG" -o /dev/null -w '%{http_code}' -X POST https://p2p.vnbot.run/pair/start)" = 401
```

Run the verify guard with 401 at the API token route while signer settings remain enabled. Preserve `GATEWAY_PRIVATE_KEY`, `DB`, `NODE_ROOM`, domains, and disabled preview settings.

## Step 2: disable the API signer

Obtain approval. Restore the protected environment backup if no unrelated environment changes occurred:

```sh
cp -- "$API_ENV_BACKUP" "$API_ENV"
chmod 600 "$API_ENV"
```

Otherwise remove only the two signer vars without printing the file:

```sh
node -e 'const f=require("node:fs"),p=process.argv[1];const s=f.readFileSync(p,"utf8").split("\n").filter(l=>!/^\s*(?:export\s+)?P2P_TOKEN_(PRIVATE_KEY|KID)\s*=/.test(l)).join("\n");f.writeFileSync(p,s,{mode:0o600});f.chmodSync(p,0o600);' "$API_ENV"
```

Remove both vars; a lone kid or private key fails startup. Ensure neither variable is still exported by the deployment shell or another confirmed Compose environment source:

```sh
unset P2P_TOKEN_PRIVATE_KEY P2P_TOKEN_KID
grep -c '^P2P_TOKEN_PRIVATE_KEY=' "$API_ENV" # 0
grep -c '^P2P_TOKEN_KID=' "$API_ENV" # 0
docker compose up -d --no-deps api
```

A zero-match `grep -c` exits 1; that is expected here. Recreate only API, then run the verify guard with `EXPECTED_TOKEN_STATUS=404`. POST must return 404 even without a cookie, while `/api/auth/ok` and gateway `/healthz` remain 200.

Shred temporary private seed files and disposable smoke keys, if they still exist. Do not shred an unrelated gateway key or the rollback backup. Retain backups securely under the incident retention policy; a backup made before enablement contains no new signer seed.

## Step 1: revert through a PR and restore the API image

Obtain approval. **IRREVERSIBLE:** the original merge was pushed to main; do not reset main or force push. Create a revert PR from current main:

```sh
git switch main
git pull --ff-only
git switch -c revert/vnb-022-p2p-tokens
git revert -m 1 <recorded-merge-commit>
```

Review the revert, run the normal checks, and merge the PR without force. If the original merge was not a merge commit, stop and prepare the correct reviewed revert instead of using `-m 1`. Rebuilding source is not a way to reproduce the previous image ID. Restore the retained immutable image from `api-image-before.txt` for immediate recovery; rebuild the reverted source through the normal image pipeline separately.

Create an API-only Compose override outside git, with no secret content:

```sh
PREVIOUS_API_IMAGE=$(cat "$EVIDENCE/api-image-before.txt")
docker image inspect --format '{{.Id}}' "$PREVIOUS_API_IMAGE"
printf 'services:\n  api:\n    image: %s\n' "$PREVIOUS_API_IMAGE" > "$EVIDENCE/api-rollback.yml"
COMPOSE_FILE="${COMPOSE_FILE}:$EVIDENCE/api-rollback.yml" docker compose up -d --no-deps --no-build --pull never api
test "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q api)")" = "$PREVIOUS_API_IMAGE"
```

The override assumes the VPS's Linux `:` Compose path separator. Preserve the exact original ordered Compose files. Keep the override in the approved deploy invocation until the reverted API image is ready. If the prior image is missing, restore its recorded immutable registry digest; do not use a moving tag as proof of identity. Build or pull only `api` for the reverted release, then recreate only `api` after approval. Do not redeploy `vnbot-app` or other services sharing `RAKAZO_IMAGE` and `RAKAZO_IMAGE_TAG`.

Run the verify guard with `EXPECTED_TOKEN_STATUS=404`. Confirm the revert is on main, API runs the recorded previous image during recovery, and gateway remains on the approved pin with an empty app-key map.

## Emergency: suspected private-key leak

Obtain emergency owner approval for each action. First remove trust at the gateway using step 3 (`APP_TOKEN_PUBLIC_KEYS="{}"`), then disable the API signer using step 2. Verify fresh app tokens are rejected (401 at gateway) and minting is off (404 at API). Never paste the leaked value into tickets, chat, commands, or logs.

Generate a new Ed25519 pair on the VPS using the runbook's file-only method. Rotate to a new unique kid, for example `app-2026-11-rotation-1`; never reuse `app-2026-10` or the compromised seed. Configure API with the new seed and kid, recreate only API, then trust only the new public key at the gateway on the same approved code. Do not retain the leaked kid during a compromise rotation.

Repeat claim checks with the new kid, the live smoke, and primary-key cleanup. Verify a fresh token under the new kid succeeds and an old-kid token is rejected. Token TTL is 120 s, but removing trust is required immediately; do not wait for expiry. Review restricted backups and logs for key copies, revoke access as needed, and shred temporary key files without printing them. Gateway private-key rotation is a separate incident procedure; this runbook does not delete that secret.
