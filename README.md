# VNBot

VNBot giúp chủ shop, doanh nghiệp nhỏ và người làm việc một mình có những con bot làm việc thật: trả lời khách, đọc mail, làm báo cáo, nhắn Telegram, dùng máy tính thay mình. Giao diện tiếng Việt trước, có English.

- **Bot có máy tính riêng**: tìm web, đọc và ghi tệp, mở trình duyệt, chạy lệnh trong máy của bot.
- **Kết nối ứng dụng** qua Marketplace: chủ máy dán key Composio một lần, mọi người trên máy dùng chung và tự kết nối tài khoản ứng dụng của mình.
- **Giọng nói**: nghe, chép chữ, đọc lại câu trả lời, và cuộc gọi bằng giọng ChatGPT có thể giao việc cho bot ngay trong lúc gọi.
- **Space và mời người**: mời nhân viên vào đúng Space, mỗi người dùng tài khoản của chính mình.
- **Việc tự động**: chạy theo lịch hoặc khi có thay đổi.
- **Kết nối từ xa**: một công tắc trong Cài đặt, mặc định tắt.

## Chạy thử bằng Docker trên Windows

Cần [Docker Desktop](https://www.docker.com/products/docker-desktop/) (bật WSL 2) và Git. Lần đầu build mất một lúc và cần khoảng 15–20 GB trống.

**1. Tải mã nguồn**

```powershell
git clone https://github.com/aikingcorp-spec/VNbot-News.git
cd VNbot-News
Copy-Item .env.example .env
```

**2. Tạo các khóa bí mật** (chạy trong PowerShell, ở thư mục vừa tải):

```powershell
function New-Secret { "$([guid]::NewGuid().ToString('N'))$([guid]::NewGuid().ToString('N'))" }
$lines = Get-Content .env
foreach ($name in 'POSTGRES_PASSWORD','POSTGRES_APP_PASSWORD','BETTER_AUTH_SECRET','ENCRYPTION_KEY','SANDBOX_SUPERVISOR_TOKEN','SCREEN_PROXY_SECRET') {
  $lines = $lines -replace "^$name=.*", "$name=$(New-Secret)"
}
Set-Content .env $lines
```

Giữ file `.env` này. Đổi `ENCRYPTION_KEY` sau khi đã dùng sẽ làm mất các key đã lưu.

**3. Mail để nhận mã đăng nhập.** Mở `.env`, điền hai dòng. Ví dụ Gmail dùng [mật khẩu ứng dụng](https://myaccount.google.com/apppasswords); chữ `@` trong tên đăng nhập viết thành `%40`:

```
SMTP_URL=smtps://ten-ban%40gmail.com:mat-khau-ung-dung@smtp.gmail.com:465
EMAIL_FROM=VNBot <ten-ban@gmail.com>
```

**4. Chạy**

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.yml up -d --build
```

**5. Mở** [http://127.0.0.1:5173](http://127.0.0.1:5173), nhập email, nhập mã nhận được trong mail. Sau đó vào Cài đặt để kết nối model AI và thử cuộc gọi.

Dừng: `docker compose --env-file .env -f infra/compose/docker-compose.yml down`. Lệnh `down -v` xóa luôn dữ liệu.

Muốn mở từ máy khác hoặc điện thoại thì cần thêm tunnel; trên chính máy này dùng `127.0.0.1` là đủ, kể cả micro cho cuộc gọi.

## Phát triển

Cần Node.js 24 (từ 24.15.0) và pnpm 12.

```bash
pnpm install
pnpm dev
```

Định dạng mã bằng Biome: `pnpm format`. Kiểm tra: `pnpm test`.

## Giấy phép

Apache License 2.0. Xem [LICENSE](./LICENSE) và [NOTICE](./NOTICE).
