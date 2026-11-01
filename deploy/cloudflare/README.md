# Cloudflare: vnbot.run và app.vnbot.run

Hai Worker tĩnh, chỉ dùng gói Free. Không có VPS hay môi trường staging nào tham gia.

| Worker | Tên miền | Phục vụ |
| --- | --- | --- |
| `vnbot-landing` | `vnbot.run`, `www.vnbot.run` | Landing (vi tại `/`, en tại `/en/`), `robots.txt`, `llms.txt`, `sitemap.xml`. `www.vnbot.run` được 301 về `vnbot.run`. |
| `vnbot-app` | `app.vnbot.run` | Trang đăng nhập tĩnh ("Sắp có"), nguồn ở `app-site/`. |

## Ghép thư mục tĩnh

Không cần chạy astro. Từ thư mục gốc repo:

```bash
deploy/cloudflare/assemble-landing.sh
```

Kết quả nằm trong `deploy/cloudflare/.out/landing` và `deploy/cloudflare/.out/app` (đã được `.gitignore`).

## Deploy bằng wrangler

Chủ tài khoản chạy `wrangler login` một lần trên máy của họ. Không commit token hay account ID.

```bash
cd deploy/cloudflare/landing && wrangler deploy
cd ../app && wrangler deploy
```

## Deploy bằng connector

Dùng khi endpoint upload assets không có sẵn qua Cloudflare API connector. Chạy trong `deploy/cloudflare`:

```bash
python3 build-worker.py .out/landing vnbot-landing www.vnbot.run
python3 build-worker.py .out/app vnbot-app -
```

Mỗi lệnh ghi `.out/deploy2-<tên>.js`, một hàm async để chạy qua connector.

## Kiểm tra

```bash
curl -sI https://vnbot.run/ | head -n 1
curl -sI https://vnbot.run/en/ | head -n 1
curl -sI https://vnbot.run/sitemap.xml | grep -i -e '^HTTP' -e '^content-type'   # application/xml
curl -s https://vnbot.run/robots.txt
curl -s https://vnbot.run/llms.txt
curl -sI https://vnbot.run/khong-co | head -n 1                                  # 404
curl -sI https://www.vnbot.run/en/ | grep -i -e '^HTTP' -e '^location'           # 301 -> https://vnbot.run/en/
curl -sI https://app.vnbot.run/ | head -n 1
```

## Real remote application

`app/wrangler.toml` now points at the real Vite output and the account-only Worker entry.
Do not deploy `app-site` or the generated static app wrapper over it. Landing assembly/deployment
is unchanged; it does not publish the application.

1. Configure the existing account service's public auth URL/trusted origin as the app origin.
   Configure its existing P2P token signer. Configure the gateway's matching application public
   keys, gateway signing key, origins, D1 migrations and optional TURN secret/URLs. Preserve
   existing keys and databases. No new account database is introduced by the app Worker.
2. From the repository root, build `pnpm --filter @rakazo/web build` with
   `VITE_P2P_GATEWAY_URL` set to the deployed HTTPS gateway origin.
3. Set app Worker `AUTH_ORIGIN` to the existing HTTPS account service origin and
   `P2P_GATEWAY_URL` to that same gateway origin used at build time. These are public settings,
   not credentials. The proxy refuses a self-referential or non-HTTPS account origin.
4. From `deploy/cloudflare/app`, run `wrangler deploy --dry-run`, inspect its bindings and assets,
   then deploy only the app Worker after the account and gateway prerequisites are verified.
   Do not run the landing deploy for this change.
5. Verify OTP delivery and verification, two-device discovery, real node RPC/chat, foreign-account
   refusal, revocation, refresh/reconnect, and direct/relay paths through the public HTTPS domain.
   An unauthenticated capabilities response or a successful asset upload does not verify these.

Native desktop enrollment uses the app account origin and the configured
`RAKAZO_P2P_GATEWAY_URL`, defaulting to the planned public P2P origin. Desktop installers must
be rebuilt for Linux and Windows to contain enrollment and local-session binding. Existing
installers do not gain these changes from a web deployment.
