# VNBot desktop

## Windows beta chưa ký / Unsigned Windows beta

Tiếng Việt: Khi SmartScreen hiện “Windows protected your PC”, chọn “More info”
(“Thông tin thêm”), rồi chọn “Run anyway” (“Vẫn chạy”). Thư mục cài đặt:
`%LOCALAPPDATA%\Programs\vnbot`.

English: When SmartScreen shows “Windows protected your PC”, click “More info”
(“Thông tin thêm”), then “Run anyway” (“Vẫn chạy”). Installation directory:
`%LOCALAPPDATA%\Programs\vnbot`.

## User data

VNBot uses `%APPDATA%\VNBot` on Windows and `~/.config/VNBot` on Linux
(or `$XDG_CONFIG_HOME/VNBot`). The local web address is in `stack/.desktop-web-url`.
Explicit `--user-data-dir` and performance test profiles override the default.

Earlier builds may have used a directory named `rakazo` or `@rakazo/desktop`.
Those profiles can contain Docker setup and persistent native data; this change
does not move them automatically. To reuse one, launch with `--user-data-dir`
pointing to that existing profile. Docker volumes remain owned by Docker.
