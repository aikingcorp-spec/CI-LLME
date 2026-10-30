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
