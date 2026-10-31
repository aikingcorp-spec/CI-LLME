# VNB-022 app-issued P2P tokens prod runbook

Planned procedure, not evidence of a deploy. POST https://app.vnbot.run/api/auth/p2p-token issues a 120 s EdDSA JWT with kid `app-2026-10`, iss `https://app.vnbot.run`, and aud `p2p.vnbot.run`.

> Never print private keys, cookies, bearer tokens, assertions, or environment values. Disable shell tracing (`set +x`). Keep sensitive files outside git with mode 600. Each step needs its own explicit owner (sếp) approval, including cleanup. Stop on any failed verify and follow [ROLLBACK-P2P-TOKEN.md](ROLLBACK-P2P-TOKEN.md). Do not continue to the next step to fix a failure.

## Preconditions and backup

- Record Rex verify PASS and its evidence reference. Record explicit owner (sếp) OK before deployment, then a separate OK for each numbered step.
- On VPS `72.62.255.70`, confirm read-only the actual API `.env` path, Compose project, working directory, and ordered Compose files. Do not infer these from the repo defaults. Inspect container labels, not container environment values:

```sh
set +x
docker compose ls
docker ps --filter label=com.docker.compose.service=api --format '{{.ID}}'
docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.project.working_dir"}} {{index .Config.Labels "com.docker.compose.project.config_files"}} {{index .Config.Labels "com.docker.compose.project.environment_file"}}' <api-container-id>
```

Before the commands below, set `EVIDENCE` to a new restricted directory outside git and create it with `umask 077; mkdir -m 700 -- "$EVIDENCE"`. Set `API_ENV` to the confirmed absolute `.env` path. Use the confirmed directory and export `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, and `COMPOSE_ENV_FILES` for that project. All `docker compose` commands below use that same context. If environment-file labels are absent, confirm the deploy invocation read-only with the operator. Do not run `docker compose config` or dump `docker inspect` output: both can expose secrets. Record operational paths and identifiers only in restricted evidence, never in a commit.

```sh
docker compose ps
API_CONTAINER=$(docker compose ps -q api)
PREVIOUS_API_IMAGE=$(docker inspect --format '{{.Image}}' "$API_CONTAINER")
printf '%s\n' "$PREVIOUS_API_IMAGE" > "$EVIDENCE/api-image-before.txt"
```

Create `EVIDENCE` as a restricted directory outside git (`umask 077`, directory mode 700). Record the current gateway deployment at 100% and pin **ee32c12c-1844-42e9-af4f-8bc1714df2dc**. Stop if the active version differs until its owner resolves the discrepancy.

Back up the API environment before any write:

```sh
umask 077
TS=$(date -u +%Y%m%dT%H%M%SZ)
API_ENV_BACKUP="${API_ENV}.bak-${TS}"
cp -- "$API_ENV" "$API_ENV_BACKUP"
chmod 600 "$API_ENV_BACKUP"
stat -c '%a' "$API_ENV_BACKUP" # 600
```

Record gateway secret and var NAMES and SHA-256 fingerprints only. Run from the gateway tooling directory. Redirect metadata before inspection:

```sh
wrangler secret list --name vnbot-p2p-gateway > "$EVIDENCE/gateway-secret-names.json"
wrangler versions view ee32c12c-1844-42e9-af4f-8bc1714df2dc --name vnbot-p2p-gateway --json > "$EVIDENCE/gateway-version-before.json"
wrangler deployments list --name vnbot-p2p-gateway > "$EVIDENCE/gateway-deployments-before.txt"
sha256sum "$EVIDENCE/gateway-secret-names.json" "$EVIDENCE/gateway-version-before.json"
```

Do not `cat` the version metadata. Use a local JSON reader to emit binding names and SHA-256 of each available var value, never the value. Preserve `GATEWAY_PRIVATE_KEY` by name only: Cloudflare cannot reveal its value, so a secret-value fingerprint is unavailable. The metadata file hash is not a private-key backup or a secret-value hash. Expected var names are `GATEWAY_PUBLIC_KEY`, `GATEWAY_KEY_ID`, `APP_TOKEN_PUBLIC_KEYS`, `APP_TOKEN_ISSUER`, `APP_TOKEN_AUDIENCE`, and `ALLOWED_ORIGINS`; secret name is `GATEWAY_PRIVATE_KEY`. Preserve `DB`, `NODE_ROOM`, custom domain, and disabled workers.dev and preview URLs.

## Verify guard

Run this block before changes and after **every** numbered step. Record status codes only. `EXPECTED_TOKEN_STATUS=404` before enablement and after step 1; use `401` after steps 2, 3, and 4. An unauthenticated request needs JSON content type to reach the session check.

```sh
docker compose ps
TOKEN_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST https://app.vnbot.run/api/auth/p2p-token -H 'Content-Type: application/json' --data '{"scope":["pair"]}')
test "$TOKEN_STATUS" = "$EXPECTED_TOKEN_STATUS"
test "$(curl -sS -o /dev/null -w '%{http_code}' https://app.vnbot.run/api/auth/ok)" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' https://p2p.vnbot.run/healthz)" = 200
```

Confirm `api` is running without restart churn. The health routes alone do not prove token acceptance.

## Step 1: merge and prepare only the API image

Obtain step 1 approval. **IRREVERSIBLE: merge pushed to main.** Undo it through a revert PR, never a history rewrite or force push.

Merge `leo/vnb-022-p2p-tokens` through the normal reviewed PR into `main`, without force. Record the merge commit and its first parent. Require a merge commit for the rollback command below. Build or pull **only** service `api`, using the confirmed production image mode:

```sh
# Choose one, matching the existing deployment:
docker compose build api
# OR
docker compose pull api
```

The image settings are `RAKAZO_IMAGE` and `RAKAZO_IMAGE_TAG` in `docker-compose.prod.yml` and `docker-compose.images.yml`; other services share them. Do not run a whole-project pull, build, or up. Do not redeploy `vnbot-app`. Do not recreate API until step 2. Keep the previous image ID locally available.

Verify the merge includes the route and Compose forwarding for `P2P_TOKEN_PRIVATE_KEY`, `P2P_TOKEN_KID`, `P2P_TOKEN_ISSUER`, and `P2P_TOKEN_AUDIENCE`. Record the prepared image ID from the selected image reference with `docker image inspect --format '{{.Id}}' <prepared-api-image-reference>`. Run the verify guard with `EXPECTED_TOKEN_STATUS=404`; the running API image must still equal `PREVIOUS_API_IMAGE`.

## Step 2: generate the key on the VPS and recreate only API

Obtain step 2 approval. Confirm the two signer vars are absent; these commands print counts only (expected 0 each):

```sh
grep -c '^P2P_TOKEN_PRIVATE_KEY=' "$API_ENV"
grep -c '^P2P_TOKEN_KID=' "$API_ENV"
```

`grep -c` exits 1 for zero matches; treat that as the expected absence, not a shell failure. Stop if either count is nonzero. Inspect optional issuer and audience overrides privately; `WEB_ORIGIN` must resolve to `https://app.vnbot.run` unless `P2P_TOKEN_ISSUER` explicitly supplies it. Audience defaults to `p2p.vnbot.run`. Both signer vars must be set together; half-configured settings fail at boot.

Generate on the VPS, never on the workstation. `KEY_DIR` is a new restricted temporary directory outside git:

```sh
umask 077
KEY_DIR=$(mktemp -d)
node -e 'const c=require("node:crypto"),f=require("node:fs"),p=require("node:path");const {privateKey,publicKey}=c.generateKeyPairSync("ed25519");const seed=privateKey.export({format:"jwk"}).d;const pub=publicKey.export({format:"jwk"}).x;f.writeFileSync(p.join(process.argv[1],"private.seed"),seed,{mode:0o600,flag:"wx"});f.writeFileSync(p.join(process.argv[1],"public.key"),pub,{mode:0o600,flag:"wx"});' "$KEY_DIR"
chmod 600 "$KEY_DIR/private.seed" "$KEY_DIR/public.key"
{ printf '\nP2P_TOKEN_PRIVATE_KEY='; cat "$KEY_DIR/private.seed"; printf '\nP2P_TOKEN_KID=app-2026-10\n'; } >> "$API_ENV"
chmod 600 "$API_ENV"
grep -c '^P2P_TOKEN_PRIVATE_KEY=' "$API_ENV" # 1
grep -c '^P2P_TOKEN_KID=' "$API_ENV" # 1
docker compose up -d --no-deps api
shred -u -- "$KEY_DIR/private.seed"
test ! -e "$KEY_DIR/private.seed"
```

Keep the separate public-key file for step 3. Shredding removes the temporary file; it does not guarantee erasure from snapshots or copy-on-write storage. Never print the private seed. Verify only API was recreated, its image equals the prepared image, and the verify guard passes with `EXPECTED_TOKEN_STATUS=401`.

## Step 3: trust the public key on the gateway

Obtain step 3 approval. Create a new version of Worker `vnbot-p2p-gateway` with **the same code as ee32c12c-1844-42e9-af4f-8bc1714df2dc**, changing only var `APP_TOKEN_PUBLIC_KEYS` to `{"app-2026-10":"<pub>"}`. Read `<pub>` from the separate public-key file. This is a public var, not `GATEWAY_PRIVATE_KEY`.

Use Cloudflare's version-edit flow to copy the pinned version's code and bindings, edit that var, and deploy the new version at 100%. Do not upload the current checkout with `wrangler deploy`; its code or placeholder bindings may differ. Preserve every other var, secret binding, D1 binding, DO binding, migration, and domain setting. Record `NEW_GATEWAY_VERSION`.

```sh
wrangler versions view "$NEW_GATEWAY_VERSION" --name vnbot-p2p-gateway --json > "$EVIDENCE/gateway-version-after.json"
wrangler deployments list --name vnbot-p2p-gateway > "$EVIDENCE/gateway-deployments-after.txt"
sha256sum "$EVIDENCE/gateway-version-after.json"
```

Inspect metadata privately and record names and fingerprints only. Verify the code matches the pin, only the intended var changed, and the recorded new version is active at 100%. Run the verify guard with `EXPECTED_TOKEN_STATUS=401`.

## Step 4: live smoke and cleanup

Obtain step 4 approval. Use a real test account and a dedicated disposable node. Keep its cookie jar, responses, and node key in mode-600 files outside git. Never record the account identity or credentials in public evidence. Use a fresh app token for every state-changing call; `jti` is single-use.

Mint to a protected file, not the terminal. `COOKIE_JAR` is the test account's existing authenticated cookie jar:

```sh
umask 077
curl --fail-with-body -sS -b "$COOKIE_JAR" -H 'Content-Type: application/json' --data '{"scope":["pair"]}' https://app.vnbot.run/api/auth/p2p-token -o "$EVIDENCE/mint.json"
node -e 'const f=require("node:fs"),a=require("node:assert/strict"),r=JSON.parse(f.readFileSync(process.argv[1],"utf8"));const [h,p]=r.token.split(".").slice(0,2).map(s=>JSON.parse(Buffer.from(s,"base64url")));a.equal(h.alg,"EdDSA");a.equal(h.typ,"vnbot-p2p+jwt");a.equal(h.kid,"app-2026-10");a.equal(p.iss,"https://app.vnbot.run");a.equal(p.aud,"p2p.vnbot.run");a.equal(p.exp-p.iat,120);a.equal(p.nbf,p.iat);a.equal(r.expiresAt,p.exp*1000);console.log({alg:h.alg,kid:h.kid,iss:p.iss,aud:p.aud,ttl:p.exp-p.iat});' "$EVIDENCE/mint.json"
```

Decoding checks the header and claims, not the signature. Gateway acceptance below proves the signed token is trusted. Do not print the raw JWT, signature, sub, email, or jti. Pass bearer headers through a protected curl config file, not command-line arguments or logs.

1. With the minted pair token, `POST https://p2p.vnbot.run/pair/start` must return 200. Store its response privately. Record the token jti and pairing code's SHA-256 hash privately for cleanup.
2. Have the disposable node sign the pairing message and `POST /pair/complete` with `code`, `nodeId`, `nodePublicKey`, `sig`, `name`, and `kind`. Expect 200. Use the existing node pairing implementation; do not substitute a fake signature.
3. Mint a fresh token with `{"scope":["session"],"nodeId":"<smoke-node-id>"}`. `POST /sessions` with `{"nodeId":"<smoke-node-id>","peerId":"<smoke-peer-id>"}` must return 200. Keep the assertion private. Connect the node and client signaling peers and verify offer/answer delivery.
4. Mint a fresh token with `{"scope":["nodes"],"nodeId":"<smoke-node-id>"}`. `DELETE /nodes/<smoke-node-id>` must return 204. Record that token's jti privately. Confirm a fresh session attempt for the unpaired node returns 404.

### IRREVERSIBLE: delete smoke rows by primary key

Obtain separate cleanup approval after reviewing SELECT results. Deleted smoke rows cannot be restored by this procedure. Never delete by email, user ID, timestamp range, or an unbounded predicate. Substitute only the recorded smoke primary keys, using SQL-safe quoting. Repeat each jti query for every token consumed by a state-changing call. Pair completion may already have consumed the pair-code row; expired jti rows may also be absent.

```sh
wrangler d1 execute vnbot-p2p-d1 --remote --command "SELECT node_id, revoked_at FROM nodes WHERE node_id = '<smoke-node-id>'; SELECT jti, exp FROM used_jti WHERE jti = '<smoke-jti>'; SELECT code_hash, expires_at FROM pair_codes WHERE code_hash = '<smoke-code-hash>';"
# IRREVERSIBLE: run only after checking the SELECTs and cleanup approval.
wrangler d1 execute vnbot-p2p-d1 --remote --command "DELETE FROM nodes WHERE node_id = '<smoke-node-id>'; DELETE FROM used_jti WHERE jti = '<smoke-jti>'; DELETE FROM pair_codes WHERE code_hash = '<smoke-code-hash>';"
wrangler d1 execute vnbot-p2p-d1 --remote --command "SELECT count(*) FROM nodes WHERE node_id = '<smoke-node-id>'; SELECT count(*) FROM used_jti WHERE jti = '<smoke-jti>'; SELECT count(*) FROM pair_codes WHERE code_hash = '<smoke-code-hash>';"
```

Expect all selected counts to be 0. Keep SELECT results restricted. Run the verify guard with `EXPECTED_TOKEN_STATUS=401`, and repeat the two `grep -c` checks from step 2 (1 each). Shred temporary credentials, assertions, token responses, and disposable node private keys. Record smoke PASS and cleanup completion without secrets or personal data. Keep the protected environment backup for rollback.
