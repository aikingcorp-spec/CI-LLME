# VNBot BRAND: bộ file đã chốt (nguồn duy nhất)
> Cập nhật 2026-10-31 22:49 (ICT), D012: icon app = bé Nón len cầm cờ (2870083f1918), được dùng trên landing; khối cam là Rakazo, cấm.
Cập nhật: 2026-10-30 (giờ Sài Gòn, UTC+7). Anh AIKING duyệt lần cuối 30/10 lúc 17:26.
Mọi bot dùng ĐÚNG các file dưới đây. Không vẽ lại, không làm bản mới, không lấy file ở chỗ khác.
Trước khi dùng file, kiểm sha256 (12 ký tự đầu) khớp bảng. Lệch là sai file: dừng lại, hỏi Maya.
Gốc thư mục: <box-Maya>/vnbot-brand/

## Bảng file đã chốt
| Hạng mục | File | sha256 (12) |
|---|---|---|
| Icon master (chỉ là icon, không phải mascot) | scripts/icons/owner-master.png (nhánh codex/kai-vnb-icons) | 2870083f1918 |
| Icon trong app | logo-v2/in-app/vnbot-rounded-1024.png | 840e99e838fd |
| Icon trong app | logo-v2/in-app/vnbot-rounded-512.png | b0f577fee1de |
| Icon trong app | logo-v2/in-app/vnbot-rounded-256.png | df2c23526195 |
| Icon trong app | logo-v2/in-app/vnbot-rounded-128.png | 8a762a5e5769 |
| Icon trong app | logo-v2/in-app/vnbot-rounded-64.png | 2fca1090b841 |
| Icon trong app | logo-v2/in-app/vnbot-rounded-32.png | 32d171d94c76 |
| Web | logo-v2/web/icon-512.png | 590b37dd5ab6 |
| Web | logo-v2/web/favicon.ico | 37bb43f2832d |
| macOS | logo-v2/macos/VNBot.icns | 5827aa3ab313 |
| Windows | logo-v2/windows/vnbot.ico | b389b6812757 |
| iOS | packages/ui-tokens/assets/VNBot.icon/Assets/vnbot.png (nhánh codex/kai-vnb-icons; main vẫn là Rakazo.icon/Assets/orange-bot.png 06048b034dca) | 31c8ce6f73f7 |
| iOS cả thư mục | logo-v2/ios/ (tree-hash) | 1cffb21e6792 |
| Android | logo-v2/android/ic_launcher-playstore-512.png | 184a07550aab |
| Android cả thư mục | logo-v2/android/ (tree-hash) | 373c98b85eb5 |
| Wordmark sáng | wordmark/vnbot-wordmark-v4-light.svg | 1b22b871f496 |
| Wordmark tối | wordmark/vnbot-wordmark-v4-dark.svg | c24395f3dfd6 |
| Wordmark powered sáng | wordmark/vnbot-wordmark-v4-powered-light.svg | 00e05c593b2e |
| Wordmark powered tối | wordmark/vnbot-wordmark-v4-powered-dark.svg | 2d51b47b3aff |
| Màu | palette/tokens.css | 7429211b715b |
| Mascot len (8 bé, mọi pose 1024/256/128) | mascot-felt-v1/ (tree-hash) | 4d8826bf85f8 |
| Mascot Nón | mascot-felt-v1/non/base.png | eb9047bf8144 |
| Mascot Sen | mascot-felt-v1/sen/base.png | 87111328baef |
| Mascot Sương | mascot-felt-v1/suong/base.png | 6af5fea72486 |
| Mascot Lồng Đèn | mascot-felt-v1/longden/base.png | 8d41d33e56a3 |
| Mascot Rằn | mascot-felt-v1/ran/base.png | 242703dbd6b7 |
| Mascot Chưng | mascot-felt-v1/chung/base.png | 572498a65503 |
| Mascot Áo Dài | mascot-felt-v1/aodai/base.png | 0a0488951be3 |
| Mascot Tre | mascot-felt-v1/tre/base.png | d0767689dc4c |
| Mascot ảnh anh đã duyệt (nguồn sự thật) | mascot-ref/owner-mascots-8.jpg | (Maya tính sha khi chép vào) |
| Pose (tilt, bounce, peek, jump, lookup, prop) | mascot-felt-v1/{slug}/{pose}.png | theo tree-hash |
| Mascot Áo Dài jump (đã chỉnh cỡ) | mascot-felt-v1/aodai/jump.png | b6e5cf0d3964 |

Cách tính tree-hash (chạy trong <box-Maya>/vnbot-brand):
`find logo-v2/ios -type f | sort | xargs sha256sum | sha256sum | cut -c1-12`
iOS và Android là bản thu nhỏ thuần từ master/rounded (đo pixel, lệch 0–0.09).

## Mascot: landing khác app (D011, anh AIKING chốt 31/10 22:39, chat trực tiếp)
Lời anh: "Cái landing thì 8 còn trên app thì 5 con trước".
| Nơi dùng | Bộ mascot | Nguồn |
|---|---|---|
| Landing vnbot.run | 8 bé len (Nón, Sen, Sương, Lồng Đèn, Rằn, Chưng, Áo Dài, Tre), đã duyệt | mascot-felt-v1/ (tree 4d8826bf85f8) → handoffs/VNB-015/mascots → apps/www/public/landing/img/mascots/ |
| App (web app, desktop, mobile) | giữ 5 bé icons-v2 (Nón, Chưng, Áo Dài, Rằn, Sen) cho tới khi anh chốt khác | icons-v2/svg/ (tree c2e3a01d56b2) |
- Không đưa Lồng Đèn, Sương, Tre vào app khi anh chưa nói.
- Icon app (bé Nón cầm cờ, 2870083f1918) ĐƯỢC dùng trên landing làm logo/nav icon (D012). Không dùng nó làm mascot.

## Lời duyệt của anh AIKING
- Icon:
  - 29/10 00:03: "logo app đc rồi"
  - 29/10 23:51: "anh nhớ đã chọn bản này rồi mà sao lại cứ làm bản mới"
  - 30/10 00:13 (với Mai): "Ừ đúng r"
  - 30/10 17:26: duyệt lần cuối bộ logo-v2, mọi nền tảng.
- Màu: 29/10 00:13: "Okee đó chốt nhen màu… để mấy cái màu gốc đã có"
- Wordmark:
  - 29/10 00:26: quy tắc dòng phụ "powered by AIKING"
  - 29/10 chiều: chốt v4 (Maya ghi lại)
  - 30/10 17:26: duyệt lần cuối v4 sáng, tối, powered.
- Mascot: **bộ 8 bé len** (Nón, Sen, Sương, Lồng Đèn, Rằn, Chưng, Áo Dài, Tre), theo ảnh anh gửi `owner-mascots-8.jpg`.
  - 30/10 khoảng 23:41: anh duyệt Nón v1 và duyệt đổi BRAND sang bộ 8 len.
  - Bộ 5 icons-v2 (SVG phẳng) bên dưới chỉ còn là lịch sử.
- (Lịch sử) Mascot bộ 5 bé icons-v2: Nón, Chưng, Áo Dài, Rằn, Sen; màu thân đổi theo palette:
  - 29/10 00:10 Maya gửi icons-v2/preview.png ("bộ 5 icon v2… Anh chốt xong thì Mai chuyển qua đọc UI Rakazo").
  - 29/10 00:13 anh trả lời: "Okee đó chốt nhen màu thì cho nhiều màu xíu nhen nhớ để mấy cái màu gốc đã có nhen oke vậy đc rồi nhắc để làm UI"
  - 29/10 01:04 anh gọi bộ này là mascot ("lỗi mascot… khăn của con số 4", tức Rằn).
  - 30/10 anh xác nhận: "Mascot đúng ùi".

## KHÔNG dùng
- Mascot nháp (đã chuyển vào _archive/2026-10-30/mascot/ ngày 30/10): vnbot-brand/icons/ (bản nháp đầu, anh chê 29/10 00:03), mascot-v1…v4, mascot-non/ (các vòng thử và avatar AI 28/10). <box-Maya>/mascot-ref/ là ảnh tham khảo anh gửi, không phải mascot.
- <box-Maya>/vnbot-brand/_archive/ (mọi thứ trong đó: logo/ cũ, android-icon/ vẽ lại phẳng đã bị loại, wordmark v2, v3, vnbot-run/, fontopt-*, compare-*).
- wordmark/vnbot-wordmark-{light,dark}.svg/png và wordmark/vnbot-wordmark-powered-{light,dark}.* (tên không có v4): bản cũ, KHÁC v4. Còn để tại chỗ chỉ vì mockup UI và ui/welcome-auth/build.py đang trỏ tới. Không dùng cho việc mới.
- Icon Rakazo cũ trong repo apps/www/public (md5 d4b9edf6…).
- **Mọi icon Rakazo** (sản phẩm khác, D012): khối cam 99c3a0e9d34a (`apps/desktop/assets/icon.png` trên main), `packages/ui-tokens/assets/Rakazo.icon/` (orange-bot.png 06048b034dca). Cấm dùng cho VNBot ở mọi nơi.
- Bất kỳ icon/wordmark nào tự vẽ lại hoặc tự sinh.
- icons-v2/svg/*.svg (bộ 5 phẳng) cho landing: landing dùng mascot-felt-v1. Riêng app vẫn giữ bộ 5 này theo D011 (apps/web VnbotMascotRow.tsx).
- Pose bị loại: VNB-015/mascots/_rejects/.
- Không có khối cam (orange blob) ở bất cứ đâu: không icon, không mascot, không landing. File 99c3a0e9d34a (`apps/desktop/assets/icon.png` trên `main`): cấm. Icon app đúng là master 2870083f1918.
- Bé Nón cầm cờ (icon 2870083f1918) không được dùng làm mascot hay pose.

## Quy tắc đặt tên
- Wordmark: "VNbot" (chữ b thường), font Baloo 2 ExtraBold, chiếc lá sau chữ "t". Tên sản phẩm trong câu chữ: VNBot.
- Dòng phụ nếu có: chỉ chữ mảnh "powered by AIKING".
- File mới phải có phiên bản trong tên (vd -v4-). Không ghi đè file đã chốt, không tạo file tên chung chung không có phiên bản.
- Đổi file đã chốt chỉ khi anh AIKING duyệt; ghi vào DECISIONS.md kèm sha256 mới và sửa bảng này.

## Màu (đề xuất, thêm vào packages/ui-web/src/vnbot-palette.css)
  --vnbot-body-suong: #9cadbe; /* xanh sương, đo từ ảnh anh (trung vị thân); mắt #1c1c1f tương phản 7.39:1 */
  Lồng Đèn dùng --vnbot-body-do-son #c8322b, Tre dùng --vnbot-body-vang-nghe #f2b705 (đã có sẵn).

## Icon ≠ mascot
- Icon app là **bé Nón len cầm cờ Việt Nam**: master sha **2870083f1918**.
  - Dùng làm icon app/desktop/web/store và logo trên landing (nav và footer, anh Hùng chốt cả hai 31/10 22:57) — anh Hùng chốt 31/10 22:49 (D012): "Brand ghi sai khúc đó á, icon app mà khối màu cam là sai cái đó là rakazo".
  - Bé Nón cầm cờ **không bao giờ** là mascot hay pose.
- Mascot và pose **không bao giờ** được:
  - cầm hay mang cờ;
  - đặt trong ô vuông bo góc hoặc vòng tròn nền kiểu icon;
  - dùng bố cục chính diện nửa người cắt sát giống icon.
- Không dùng mascot làm icon, và không dùng icon làm mascot (logo nav/footer thì được).
- Không có khối cam (orange blob) ở bất cứ đâu: đó là icon Rakazo 99c3a0e9d34a, không phải VNBot (D012).
- QC mỗi pose của Nón: đặt cạnh icon 2870083f1918 và kiểm 3 điều trên.
