# VNBot BRAND: bộ file đã chốt (nguồn duy nhất)
Cập nhật: 2026-10-31 22:39 (giờ Sài Gòn, UTC+7): thêm tách mascot landing/app (VNB-029). Trước đó: Anh AIKING duyệt lần cuối 30/10 lúc 17:26.
Mọi bot dùng ĐÚNG các file dưới đây. Không vẽ lại, không làm bản mới, không lấy file ở chỗ khác.
Trước khi dùng file, kiểm sha256 (12 ký tự đầu) khớp bảng. Lệch là sai file: dừng lại, hỏi Maya.
Gốc thư mục: <box-Maya>/vnbot-brand/

## Bảng file đã chốt
| Hạng mục | File | sha256 (12) |
|---|---|---|
| Icon master | logo-v2/full-bleed/vnbot-master-1024.png | 89da68e9ce67 |
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
| iOS | logo-v2/ios/AppIcon.appiconset/icon-1024.png | 89da68e9ce67 (trùng master) |
| iOS cả thư mục | logo-v2/ios/ (tree-hash) | 1cffb21e6792 |
| Android | logo-v2/android/ic_launcher-playstore-512.png | 184a07550aab |
| Android cả thư mục | logo-v2/android/ (tree-hash) | 373c98b85eb5 |
| Wordmark sáng | wordmark/vnbot-wordmark-v4-light.svg | 1b22b871f496 |
| Wordmark tối | wordmark/vnbot-wordmark-v4-dark.svg | c24395f3dfd6 |
| Wordmark powered sáng | wordmark/vnbot-wordmark-v4-powered-light.svg | 00e05c593b2e |
| Wordmark powered tối | wordmark/vnbot-wordmark-v4-powered-dark.svg | 2d51b47b3aff |
| Màu | palette/tokens.css | 7429211b715b |
| Mascot (5 bé) | icons-v2/svg/ (tree-hash) | c2e3a01d56b2 |
| Mascot Nón | icons-v2/svg/non.svg | d0684b5ae825 |
| Mascot Chưng | icons-v2/svg/chung.svg | 29e5a6c51f9a |
| Mascot Áo Dài | icons-v2/svg/aodai.svg | 19993a924150 |
| Mascot Rằn | icons-v2/svg/ran.svg | 527278cc0f19 |
| Mascot Sen | icons-v2/svg/sen.svg | 737bd46a9bee |
| Mascot PNG 64/256 | icons-v2/png/ (tree-hash) | 1b1d31f7cdce |
| Mascot ảnh anh đã duyệt | icons-v2/preview.png | 82ccdf277b81 |

Cách tính tree-hash (chạy trong <box-Maya>/vnbot-brand):
`find logo-v2/ios -type f | sort | xargs sha256sum | sha256sum | cut -c1-12`
iOS và Android là bản thu nhỏ thuần từ master/rounded (đo pixel, lệch 0–0.09).

## Mascot: landing khác app (anh AIKING chốt 31/10 22:39, chat trực tiếp)
Lời anh: "Cái landing thì 8 còn trên app thì 5 con trước".
| Nơi dùng | Bộ mascot | Nguồn |
|---|---|---|
| App (web app, desktop, mobile) | 5 bé icons-v2: Nón, Chưng, Áo Dài, Rằn, Sen | icons-v2/svg/ (tree c2e3a01d56b2), như bảng trên |
| Landing vnbot.run | 8 bé: Nón, Chưng, Áo Dài, Rằn, Sen, Lồng Đèn (longden), Sương (suong), Tre (tre) | handoffs/VNB-015/mascots → apps/www/public/landing/img/mascots/ (VNB-025 @9e2bd7ae) |
- Landing dùng thiết kế VNB-025 của Mai, bỏ ảnh chụp sản phẩm.
- Không đưa Lồng Đèn, Sương, Tre vào app khi anh chưa duyệt.
- Icon ứng dụng (bé Nón cầm cờ) không dùng trên landing.

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
- Mascot (bộ 5 bé icons-v2: Nón, Chưng, Áo Dài, Rằn, Sen; màu thân đổi theo palette):
  - 29/10 00:10 Maya gửi icons-v2/preview.png ("bộ 5 icon v2… Anh chốt xong thì Mai chuyển qua đọc UI Rakazo").
  - 29/10 00:13 anh trả lời: "Okee đó chốt nhen màu thì cho nhiều màu xíu nhen nhớ để mấy cái màu gốc đã có nhen oke vậy đc rồi nhắc để làm UI"
  - 29/10 01:04 anh gọi bộ này là mascot ("lỗi mascot… khăn của con số 4", tức Rằn).
  - 30/10 anh xác nhận: "Mascot đúng ùi".

## KHÔNG dùng
- Mascot nháp (đã chuyển vào _archive/2026-10-30/mascot/ ngày 30/10): vnbot-brand/icons/ (bản nháp đầu, anh chê 29/10 00:03), mascot-v1…v4, mascot-non/ (các vòng thử và avatar AI 28/10). <box-Maya>/mascot-ref/ là ảnh tham khảo anh gửi, không phải mascot.
- <box-Maya>/vnbot-brand/_archive/ (mọi thứ trong đó: logo/ cũ, android-icon/ vẽ lại phẳng đã bị loại, wordmark v2, v3, vnbot-run/, fontopt-*, compare-*).
- wordmark/vnbot-wordmark-{light,dark}.svg/png và wordmark/vnbot-wordmark-powered-{light,dark}.* (tên không có v4): bản cũ, KHÁC v4. Còn để tại chỗ chỉ vì mockup UI và ui/welcome-auth/build.py đang trỏ tới. Không dùng cho việc mới.
- Icon Rakazo cũ trong repo apps/www/public (md5 d4b9edf6…).
- Bất kỳ icon/wordmark nào tự vẽ lại hoặc tự sinh.

## Quy tắc đặt tên
- Wordmark: "VNbot" (chữ b thường), font Baloo 2 ExtraBold, chiếc lá sau chữ "t". Tên sản phẩm trong câu chữ: VNBot.
- Dòng phụ nếu có: chỉ chữ mảnh "powered by AIKING".
- File mới phải có phiên bản trong tên (vd -v4-). Không ghi đè file đã chốt, không tạo file tên chung chung không có phiên bản.
- Đổi file đã chốt chỉ khi anh AIKING duyệt; ghi vào DECISIONS.md kèm sha256 mới và sửa bảng này.
