# Bản đồ VNBot

VNBot hôm nay vẫn chạy hệ Rakazo trên máy khách. Web đã đổi lớp nhìn thấy: màu ôliu, đăng nhập bằng email rồi mã 6 số, và tiếng Việt là ngôn ngữ mặc định. Đường ghép nối và kênh dữ liệu WebRTC đã có mã cho web và desktop; triển khai thực tế và đường qua TURN chưa được kiểm chứng trong thay đổi này. Bản đóng băng tại commit `c4b24547` nằm ở `docs/architecture/rakazo-baseline/ban-do-rakazo-goc.md`. Những gì đã đổi được ghi ở `docs/architecture/vnbot/CHANGELOG-ARCHITECTURE.md`.

Đăng nhập có thể chỉ còn mã email: `AUTH_EMAIL_CODE_ONLY` đóng đường mật khẩu, passkey vẫn dùng được. `AUTH_EMAIL_ALLOWLIST=on` thì chỉ email trong bảng `auth_email_allowlist` nhận được mã, tạo được tài khoản, hoặc mở được phiên. Địa chỉ không có trong danh sách nhận HTTP 403 `EMAIL_NOT_INVITED` và không có email. Bot mới mặc định bộ avatar `vnbot`; bot cũ giữ bộ đã lưu.

Bản cài đặt dùng kho `aikingcorp-spec/vnbot` và image cùng tên trên GHCR. Tự cập nhật mặc định tắt cho tới khi có bản phát hành chính thức; người vận hành phải bật rõ ràng bằng `RAKAZO_DISABLE_AUTO_UPDATE=0`. Không kèm thông tin xác thực. Xem [ADR 0008](adr/0008-distribution-and-update-opt-in.md).

Ví thanh toán đã được gỡ khỏi giao diện và RPC của node. Bảng `payment_wallets` và dữ liệu cũ được giữ nguyên; không có migration xóa bảng.

Desktop Linux và Windows đã có mã chạy node cục bộ không cần Docker: PostgreSQL 16 đi kèm, API và worker chạy bằng Electron utility process, giao diện web dùng lại bản chung. macOS vẫn dùng Docker. Bản phát hành native còn chờ đóng gói binary và tài nguyên server; chưa phải bản cài đặt đã kiểm chứng. Quyền chạy lệnh trên máy vẫn theo thiết lập hiện có. Xem [ADR 0009](adr/0009-native-desktop-local-runtime.md).

## Cổng vnbot.run và máy của khách: đã có đường web P2P

Khách chạy cả hệ thống trên máy của họ (Mac mini ở nhà, máy văn phòng, hoặc VPS của họ). Máy đó là một nút: API, worker, cơ sở dữ liệu, và máy tính của bot. Dữ liệu chat ở lại đó.

vnbot.run là cổng chúng ta giữ. Người dùng đăng nhập bằng email trên web hoặc điện thoại, thấy các nút đã ghép, và điều khiển nút từ xa. Cổng không lưu cuộc trò chuyện. Nó chỉ biết ai được vào nút nào, giúp hai bên tìm nhau, và chuyển tiếp khi mạng nhà không mở đường thẳng.

Điện thoại hoặc trình duyệt nói với nút bằng WebRTC. Phần chat đi trên kênh dữ liệu. Hình và tiếng, nếu có, là bước sau. Khi hai bên không nối thẳng được, máy TURN của cổng chỉ chuyển gói đã mã hóa.

```mermaid
flowchart LR
  User[Web hoặc điện thoại tại vnbot.run]
  Gate[Cổng: đăng nhập, danh sách nút, bắt tay]
  Node[Nút tại nhà khách: chat và bot]

  User --> Gate
  Gate -->|ghép nối, không giữ chat| Node
  User -->|kênh dữ liệu, thẳng hoặc qua TURN| Node
```

Nút không cần mở cổng vào. Một chương trình nhỏ trên nút tự gọi ra cổng để giữ đường bắt tay.

Quyền: đăng nhập ở vnbot.run chỉ đủ để xin nối vào nút của mình. Nút tự kiểm tra chữ ký và người đó đã được ghép chưa, rồi mới cho gọi API. Mật khẩu và phiên của nút không gửi lên cổng.

Bản web có cấu hình cổng P2P (`VITE_P2P_GATEWAY_URL`) mở màn hình ghép nối trước khi vào ứng dụng. Web xin token từ `/api/auth/p2p-token`, lấy mã ghép và danh sách máy từ cổng đã cấu hình, rồi bắt tay qua WebSocket. Các lời gọi RPC và luồng sự kiện tới máy đã chọn đi trên kênh dữ liệu WebRTC; mất kết nối thì quay lại màn hình ghép nối, không gửi RPC sang cổng. Bản web chưa cấu hình cổng thì P2P tắt hẳn: không có cổng mặc định, menu tài khoản ẩn mục ghép nối, `/app/pairing` chỉ báo lỗi cấu hình, không xin token và không gọi cổng nào. Bản đó và Electron vẫn gọi API trực tiếp như trước. Web và desktop xin thông tin xác thực TURN ngắn hạn từ cổng khi đã cấu hình; nếu chưa bật hoặc có lỗi thì giữ STUN mặc định. Máy desktop xin lại trước mỗi kết nối mới. Đường TURN thực tế chưa được kiểm chứng ngoài mạng cục bộ.

Ba bước: trước hết https tới nút qua đường hầm; rồi kênh dữ liệu WebRTC; sau cùng mới tới hình và tiếng trên cùng kết nối đó. Ảnh màn hình bot bên trong nút không phải việc của đề xuất này.

Quyết định đang ở trạng thái đề xuất: `docs/architecture/vnbot/adr/0001-hosted-gateway-and-self-hosted-node-over-webrtc.md`.

VNB-044 chỉ bổ sung giao diện web (dùng được ở chiều rộng 360px); Expo chưa có màn hình này. Các đường HTTP ngoài RPC như tệp và màn hình máy tính chưa được chuyển sang kênh dữ liệu.

### Desktop và web từ xa

Desktop native xác minh email OTP ở dịch vụ tài khoản, mở phiên trên node qua capability riêng của main và đăng ký khóa máy bằng token tài khoản cộng chữ ký máy. RPC qua WebRTC dùng phiên local đã gắn với tài khoản đó. Worker app phục vụ SPA thật, chỉ chuyển endpoint tài khoản; chat vẫn ở node. Xem [ADR 0010](adr/0010-desktop-account-enrollment.md) về giới hạn kiểm chứng và cấu hình cần triển khai.
