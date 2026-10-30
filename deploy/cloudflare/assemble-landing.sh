#!/usr/bin/env bash
# Ghép thư mục tĩnh của landing và app từ apps/www mà không chạy astro.
# Dùng: deploy/cloudflare/assemble-landing.sh [thư_mục_landing]
# Mặc định: deploy/cloudflare/.out/landing. Thư mục app được ghép cạnh đó (../app).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
www="$here/../../apps/www"
out="${1:-$here/.out/landing}"
app="$(dirname "$out")/app"

rm -rf "$out" "$app"
mkdir -p "$out/en" "$app/landing"

# Landing: public/ + hai trang HTML + 404
cp -R "$www/public/." "$out/"
cp "$www/src/landing/vi.html" "$out/index.html"
cp "$www/src/landing/en.html" "$out/en/index.html"
sed -n '/^<!doctype/,$p' "$www/src/pages/404.astro" > "$out/404.html"

printf 'User-agent: *\nAllow: /\n\nSitemap: https://vnbot.run/sitemap.xml\n' > "$out/robots.txt"
cat > "$out/llms.txt" <<'TXT'
# VNBot

> Đội nhân viên AI của riêng bạn. Mỗi bot có trí nhớ, máy tính riêng và tự làm việc theo lịch. Dùng mô hình AI bạn đã có. Dữ liệu là của bạn.

- [VNBot (Tiếng Việt)](https://vnbot.run/)
- [VNBot (English)](https://vnbot.run/en/)
TXT
rm -f "$out/vercel.json"

# App: trang đăng nhập tĩnh + tài nguyên dùng chung của landing
cp -R "$here/app-site/." "$app/"
cp -R "$www/public/landing/styles.css" "$www/public/landing/fonts" "$www/public/landing/img" "$app/landing/"
cp "$www"/public/landing/favicon* "$www/public/landing/apple-touch-icon.png" "$app/landing/"

echo "landing: $out"
echo "app:     $app"
