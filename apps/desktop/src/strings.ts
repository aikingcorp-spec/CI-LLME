export type Locale = "vi" | "en";

const vi = {
  menu: {
    computerAccess: "Quyền truy cập máy tính…",
    revokeComputerAccess: "Thu hồi quyền dùng máy tính này",
    checkForUpdates: "Kiểm tra cập nhật…",
    changeServer: "Đổi máy chủ VNBot…",
    stopLocalStack: "Dừng VNBot trên máy này",
    view: "Xem",
    window: "Cửa sổ",
    file: "Tệp",
    edit: "Chỉnh sửa",
    undo: "Hoàn tác",
    redo: "Làm lại",
    cut: "Cắt",
    copy: "Sao chép",
    paste: "Dán",
    selectAll: "Chọn tất cả",
    resetZoom: "Cỡ chữ mặc định",
    zoomIn: "Phóng to",
    zoomOut: "Thu nhỏ",
    fullScreen: "Toàn màn hình",
    minimize: "Thu nhỏ cửa sổ",
    close: "Đóng cửa sổ",
    quit: "Thoát VNBot",
  },
  computerAccess: {
    title: "Cho phép truy cập máy tính cục bộ?",
    message: "Cho phép bot sử dụng máy tính này?",
    detail:
      "Các bot trên {where} có thể chạy lệnh, đọc và thay đổi tệp, cũng như mở ứng dụng với quyền của tài khoản bạn. Bạn có thể thu hồi quyền này {revokeWhere}.",
    cancel: "Hủy",
    allow: "Cho phép",
    localInstance: "phiên bản cục bộ này",
    fromAppMenu: "từ menu ứng dụng",
    inSettings: "trong Cài đặt",
    requiresManagedInstance:
      "Quyền truy cập máy tính cục bộ cần một phiên bản cục bộ do ứng dụng quản lý.",
    serverUnavailable: "Máy chủ cục bộ không khả dụng.",
  },
  updateDialog: {
    ready: "VNBot {version} đã sẵn sàng để cài đặt.",
    restart: "Khởi động lại",
    later: "Để sau",
    installFailed: "Không thể cài đặt bản cập nhật.",
    checkFailed: "Không thể kiểm tra cập nhật.",
    upToDate: "VNBot đã là phiên bản mới nhất.",
    version: "Phiên bản {version}",
  },
  updater: {
    disabled: "Tính năng tự động cập nhật đã bị tắt cho bản cài đặt này.",
    notInstalled: "Tự động cập nhật chỉ hoạt động trên bản đã cài đặt.",
    msiUnsupported: "Bản cài đặt MSI nhận cập nhật bằng cách cài đặt lại VNBot.",
    noReleases: "Chưa có bản cập nhật máy tính nào được phát hành cho phiên bản này.",
    unverified:
      "Không thể xác minh bản cập nhật này. Hãy cài đặt lại VNBot từ nguồn tải đáng tin cậy.",
    failed: "Không thể hoàn tất cập nhật. Vui lòng thử lại sau.",
    unreachable: "Không thể kết nối đến máy chủ cập nhật.",
  },
  signIn: {
    invalid: "Yêu cầu đăng nhập không hợp lệ.",
    alreadyActive: "Đã có một lần đăng nhập đang chạy. Hãy hủy rồi thử lại.",
    couldNotOpen:
      "Không thể mở đăng nhập bằng trình duyệt. Hãy đóng các lần đăng nhập khác rồi thử lại.",
    done: "Bạn có thể đóng thẻ này và quay lại VNBot.",
    rejected: "Yêu cầu đăng nhập bị từ chối. Hãy quay lại VNBot để thử lại.",
  },
  server: {
    invalidAddress: "Hãy nhập địa chỉ http:// hoặc https:// hợp lệ.",
    redirects:
      "Địa chỉ này chuyển hướng sang nơi khác. Hãy nhập địa chỉ cuối cùng của máy chủ VNBot.",
    http: "Máy chủ trả về lỗi HTTP {status}.",
    notVnbot: "Địa chỉ này không phản hồi như một máy chủ VNBot.",
    timeout: "Hết thời gian chờ khi kết nối đến địa chỉ này.",
    refused: "Chưa có dịch vụ nào đang lắng nghe tại địa chỉ này.",
    hostNotFound: "Không tìm thấy máy chủ này.",
    certificate: "Chứng chỉ HTTPS của máy chủ bị từ chối.",
    unreachable: "Không thể kết nối đến địa chỉ này.",
    pageNotReady: "Trang của máy chủ chưa sẵn sàng.",
    pageFailed: "Không tải được trang.",
    rendererStopped: "Trình hiển thị đã dừng ({reason}).",
    rendererStoppedAfterLoad: "Trình hiển thị đã dừng sau khi tải.",
    couldNotOpen: "Không thể mở máy chủ đó. {detail}",
    couldNotOpenUnchanged: "Không thể mở máy chủ đó. Phiên bản trước vẫn được giữ nguyên.",
    couldNotReconnect: "Không thể kết nối lại với máy chủ đã lưu. {error}",
    rendererStoppedRestored:
      "Không thể mở máy chủ đó. Trình hiển thị đã dừng. Phiên bản trước đã được khôi phục cho lần mở sau.",
    rendererStoppedPlain: "Không thể mở máy chủ đó. Trình hiển thị đã dừng.",
  },
  setupIpc: {
    inactive: "Thiết lập hiện không hoạt động.",
    enterAddress: "Hãy nhập địa chỉ máy chủ.",
    busy: "Một lần kết nối khác đang chạy.",
    invalidSetup:
      "Hãy nhập địa chỉ máy chủ hợp lệ. Máy chủ công khai phải dùng HTTPS; phiên bản cục bộ mới phải dùng localhost.",
    managedNotReady: "Các dịch vụ VNBot do ứng dụng quản lý chưa sẵn sàng. Hãy thử thiết lập lại.",
    saveRestored: "Không thể lưu thiết lập. Phiên bản trước đã được khôi phục.",
    saveFailed:
      "Đã kết nối nhưng không thể lưu thiết lập cho lần mở sau. Hãy nhấn Tiếp tục lần nữa.",
  },
  stack: {
    dockerGroup:
      "Người dùng này không có quyền truy cập Docker. Hãy thêm vào nhóm docker (sudo usermod -aG docker $USER), đăng xuất rồi đăng nhập lại, sau đó kiểm tra lại.",
    stopFailed: "Không thể dừng dịch vụ cục bộ. Hãy kiểm tra Docker đang chạy rồi thử lại.",
    interrupted: "Quá trình khởi động bị gián đoạn. Hãy thử lại để tiếp tục.",
    imageNotFound: "Chưa có image cho {imageTag}. Hãy thử lại sau vài phút.",
    portInUse: "Không thể gán cổng cục bộ sau nhiều lần thử. Hãy thử lại để chọn cổng khác.",
    addressPoolExhausted:
      "Docker không còn dải địa chỉ mạng trống. Hãy xóa các mạng Docker không dùng hoặc mở rộng dải địa chỉ của Docker, rồi thử lại.",
    network: "Không thể kết nối đến kho image. Hãy kiểm tra kết nối Internet rồi thử lại.",
    daemonDown: "Docker không phản hồi. Hãy khởi động Docker rồi thử lại.",
    composeMissing:
      "Thiếu Docker Compose. Hãy cài Docker Desktop hoặc docker-compose-plugin rồi thử lại.",
    pullFailed: "Tải image VNBot không thành công. Hãy xem chi tiết kỹ thuật bên dưới rồi thử lại.",
    startFailed: "Các dịch vụ VNBot không khởi động được. Hãy thử lại.",
    prepareFailed: "Không thể chuẩn bị dịch vụ cục bộ. Hãy thử lại.",
    dockerMissing: "Máy tính này chưa cài Docker.",
    composeNotInstalled:
      "Đã cài Docker nhưng thiếu Docker Compose. Hãy cài Docker Desktop hoặc docker-compose-plugin.",
    dockerNotRunning:
      "Đã cài Docker nhưng Docker chưa chạy. Hãy khởi động Docker rồi kiểm tra lại.",
    webNoAnswer:
      "Các dịch vụ đã khởi động nhưng ứng dụng web không phản hồi. Hãy thử lại và xem chi tiết kỹ thuật bên dưới.",
  },
  setup: {
    windowTitle: "Thiết lập VNBot",
    quit: "Thoát",
    quitTitle: "Thoát VNBot",
    heading: "Chào mừng đến với VNBot",
    subheading: "Chọn nơi VNBot sẽ chạy.",
    subheadingEmail: "Nhập email để nhận mã đăng nhập.",
    subheadingCode: "Nhập mã 6 chữ số đã gửi đến {email}.",
    legacyProfileNotice:
      "Đã tìm thấy dữ liệu từ phiên bản cũ 0.3.5 tại {path}. Bản này chưa nhập dữ liệu đó; dữ liệu cũ vẫn được giữ nguyên.",
    dismissLegacyProfile: "Đã hiểu",
    emailLabel: "Email",
    sendCode: "Gửi mã",
    codeLabel: "Mã 6 chữ số",
    verifyCode: "Xác nhận",
    resendCode: "Gửi lại mã",
    changeEmail: "Đổi email",
    sendingCode: "Đang gửi mã…",
    verifyingCode: "Đang xác nhận…",
    codeResent: "Đã gửi mã mới.",
    enterEmail: "Hãy nhập email hợp lệ.",
    enterCode: "Hãy nhập đủ 6 chữ số.",
    otpInvalid: "Mã không đúng. Hãy kiểm tra email rồi thử lại.",
    otpExpired: "Mã đã hết hạn. Hãy gửi mã mới.",
    otpNotInvited: "Email này chưa được mời dùng VNBot.",
    otpRateLimited: "Thử quá nhiều lần. Hãy đợi một lát rồi thử lại.",
    otpNetwork: "Không thể kết nối đến máy chủ tài khoản. Hãy kiểm tra Internet rồi thử lại.",
    otpUnavailable:
      "Đăng nhập tạm thời chưa khả dụng: máy chủ tài khoản VNBot chưa sẵn sàng. Dữ liệu của bạn không bị ảnh hưởng. Vui lòng thử lại sau.",
    otpFailed: "Không thể đăng nhập. Hãy thử lại.",
    comingSoon: "Sắp có",
    legend: "Máy",
    modeCloud: "VNBot Cloud",
    modeNew: "Máy tính này",
    modeExisting: "Máy của bạn (VPS, Mac mini, máy chủ riêng…)",
    pairingComingSoon: "Kết nối qua ghép cặp — sắp có",
    technicalDetails: "Chi tiết kỹ thuật",
    progress: "Tiến trình thiết lập",
    serverAddress: "Địa chỉ máy chủ",
    serverPlaceholder: "https://vnbot.example.com",
    check: "Kiểm tra kết nối",
    continue: "Tiếp tục",
    checkAgain: "Kiểm tra lại",
    retry: "Thử lại",
    phasePreparing: "Đang chuẩn bị…",
    phasePulling: "Đang tải VNBot…",
    phaseStarting: "Đang khởi động VNBot…",
    phaseWaiting: "Sắp xong…",
    phaseReady: "VNBot đã sẵn sàng.",
    downloaded: "Đã tải {size}",
    connecting: "Đang kết nối…",
    saveFailed: "Không thể lưu địa chỉ này.",
    saveFailedRetry: "Không thể lưu địa chỉ này. Hãy thử lại.",
    followFailed: "Không thể theo dõi dịch vụ cục bộ. Hãy thử lại.",
    startFailed: "Không thể khởi động dịch vụ cục bộ. Hãy thử lại.",
    enterAddressFirst: "Hãy nhập địa chỉ máy chủ trước.",
    checking: "Đang kiểm tra…",
    answered: "VNBot đã phản hồi tại {url}.",
    unreachable: "Không thể kết nối đến địa chỉ này.",
    checkFailed: "Không thể kiểm tra kết nối. Hãy thử lại.",
    bridgeUnavailable: "Không có cầu nối thiết lập.",
    setupFailed: "Không thể bắt đầu thiết lập. Hãy thoát VNBot rồi thử lại.",
  },
};

export type Strings = typeof vi;

const en: Strings = {
  menu: {
    computerAccess: "Computer Access…",
    revokeComputerAccess: "Revoke Local Computer Access",
    checkForUpdates: "Check for Updates…",
    changeServer: "Change VNBot Server…",
    stopLocalStack: "Stop Local Stack",
    view: "View",
    window: "Window",
    file: "File",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    resetZoom: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    fullScreen: "Toggle Full Screen",
    minimize: "Minimize",
    close: "Close Window",
    quit: "Quit VNBot",
  },
  computerAccess: {
    title: "Allow local computer access?",
    message: "Allow bots to use this computer?",
    detail:
      "Bots on {where} can run commands, read and change files, and launch apps with your account’s permissions. You can revoke access {revokeWhere}.",
    cancel: "Cancel",
    allow: "Allow",
    localInstance: "this local instance",
    fromAppMenu: "from the app menu",
    inSettings: "in Settings",
    requiresManagedInstance: "Local computer access requires an app-managed local instance.",
    serverUnavailable: "Local server is unavailable.",
  },
  updateDialog: {
    ready: "VNBot {version} is ready to install.",
    restart: "Restart",
    later: "Later",
    installFailed: "Could not install the update.",
    checkFailed: "Could not check for updates.",
    upToDate: "VNBot is up to date.",
    version: "Version {version}",
  },
  updater: {
    disabled: "Automatic updates are turned off for this install.",
    notInstalled: "Automatic updates only run in an installed build.",
    msiUnsupported: "MSI installs receive updates by reinstalling VNBot.",
    noReleases: "No desktop releases are published for this build yet.",
    unverified: "This update could not be verified. Reinstall VNBot from a trusted download.",
    failed: "The update could not be completed. Try again later.",
    unreachable: "Could not reach the update server.",
  },
  signIn: {
    invalid: "Invalid sign-in request.",
    alreadyActive: "A sign-in attempt is already active. Cancel it and retry.",
    couldNotOpen: "Could not open browser sign-in. Close other sign-in attempts and retry.",
    done: "You can close this tab and return to VNBot.",
    rejected: "Sign-in callback rejected. Return to VNBot to retry.",
  },
  server: {
    invalidAddress: "Enter a valid http:// or https:// address.",
    redirects: "That address redirects elsewhere. Enter the final VNBot server address.",
    http: "The server answered with HTTP {status}.",
    notVnbot: "That address did not respond like a VNBot server.",
    timeout: "Timed out reaching that address.",
    refused: "Nothing is listening at that address yet.",
    hostNotFound: "That host could not be found.",
    certificate: "The server's HTTPS certificate was rejected.",
    unreachable: "Could not reach that address.",
    pageNotReady: "The server page did not become ready.",
    pageFailed: "Page failed to load.",
    rendererStopped: "Renderer stopped ({reason}).",
    rendererStoppedAfterLoad: "Renderer stopped after load.",
    couldNotOpen: "Could not open that server. {detail}",
    couldNotOpenUnchanged: "Could not open that server. The previous instance was left unchanged.",
    couldNotReconnect: "Could not reconnect to the saved server. {error}",
    rendererStoppedRestored:
      "Could not open that server. Renderer stopped. The previous instance was restored for the next launch.",
    rendererStoppedPlain: "Could not open that server. Renderer stopped.",
  },
  setupIpc: {
    inactive: "Setup is not active.",
    enterAddress: "Enter a server address.",
    busy: "A connection attempt is already running.",
    invalidSetup:
      "Enter a valid server address. Public servers require HTTPS; a new local instance must use localhost.",
    managedNotReady: "The app-managed VNBot services are not ready. Retry setup.",
    saveRestored: "Could not save setup. The previous instance was restored.",
    saveFailed: "Connected, but could not save setup for the next launch. Try Continue again.",
  },
  stack: {
    dockerGroup:
      "This user cannot access Docker. Add it to the docker group (sudo usermod -aG docker $USER), sign out and back in, then check again.",
    stopFailed: "Could not stop the local stack. Check that Docker is running, then try again.",
    interrupted: "The start was interrupted. Retry to continue.",
    imageNotFound: "Images for {imageTag} are not published yet. Try again in a few minutes.",
    portInUse: "Could not bind a local port after retrying. Retry to choose another port.",
    addressPoolExhausted:
      "Docker has no free network address pools. Remove unused Docker networks or expand Docker’s address pools, then retry.",
    network: "Could not reach the image registry. Check the internet connection, then retry.",
    daemonDown: "Docker stopped answering. Start Docker, then retry.",
    composeMissing:
      "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.",
    pullFailed: "Downloading VNBot images failed. Check the output below, then retry.",
    startFailed: "VNBot services did not start. Try again.",
    prepareFailed: "Could not prepare the local stack. Retry.",
    dockerMissing: "Docker is not installed on this computer.",
    composeNotInstalled:
      "Docker is installed, but Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin.",
    dockerNotRunning: "Docker is installed but not running. Start Docker, then check again.",
    webNoAnswer:
      "The stack started but the web app did not answer. Retry, and check the output below.",
  },
  setup: {
    windowTitle: "Set up VNBot",
    quit: "Quit",
    quitTitle: "Quit VNBot",
    heading: "Welcome to VNBot",
    subheading: "Choose where VNBot runs.",
    subheadingEmail: "Enter your email to get a sign-in code.",
    subheadingCode: "Enter the 6-digit code sent to {email}.",
    legacyProfileNotice:
      "Found data from the old 0.3.5 version at {path}. This version has not imported it; the old data is kept unchanged.",
    dismissLegacyProfile: "Đã hiểu",
    emailLabel: "Email",
    sendCode: "Send code",
    codeLabel: "6-digit code",
    verifyCode: "Confirm",
    resendCode: "Resend code",
    changeEmail: "Change email",
    sendingCode: "Sending code…",
    verifyingCode: "Verifying…",
    codeResent: "New code sent.",
    enterEmail: "Enter a valid email address.",
    enterCode: "Enter all 6 digits.",
    otpInvalid: "That code isn't right. Check your email and try again.",
    otpExpired: "This code has expired. Send a new one.",
    otpNotInvited: "This email is not invited to VNBot yet.",
    otpRateLimited: "Too many attempts. Wait a moment and try again.",
    otpNetwork: "Could not reach the account server. Check your internet connection and try again.",
    otpUnavailable:
      "Đăng nhập tạm thời chưa khả dụng: máy chủ tài khoản VNBot chưa sẵn sàng. Dữ liệu của bạn không bị ảnh hưởng. Vui lòng thử lại sau.",
    otpFailed: "Could not sign in. Try again.",
    comingSoon: "Coming soon",
    legend: "Machine",
    modeCloud: "VNBot Cloud",
    modeNew: "This computer",
    modeExisting: "Your own machine (VPS, Mac mini, any server)",
    pairingComingSoon: "Connect by pairing — coming soon",
    technicalDetails: "Technical details",
    progress: "Setup progress",
    serverAddress: "Server address",
    serverPlaceholder: "https://vnbot.example.com",
    check: "Check connection",
    continue: "Continue",
    checkAgain: "Check again",
    retry: "Retry",
    phasePreparing: "Getting ready…",
    phasePulling: "Downloading VNBot…",
    phaseStarting: "Starting VNBot…",
    phaseWaiting: "Almost ready…",
    phaseReady: "VNBot is ready.",
    downloaded: "{size} downloaded",
    connecting: "Connecting…",
    saveFailed: "Could not save that address.",
    saveFailedRetry: "Could not save that address. Try again.",
    followFailed: "Could not follow the local stack. Try again.",
    startFailed: "Could not start the local stack. Try again.",
    enterAddressFirst: "Enter a server address first.",
    checking: "Checking…",
    answered: "VNBot answered at {url}.",
    unreachable: "Could not reach that address.",
    checkFailed: "Could not run the connection check. Try again.",
    bridgeUnavailable: "Setup bridge unavailable.",
    setupFailed: "Setup could not start. Quit VNBot and try again.",
  },
};

const DICTIONARY: Record<Locale, Strings> = { vi, en };

let active: Locale = "vi";

export function resolveLocale(appLocale: string | undefined): Locale {
  if (appLocale === undefined || appLocale.trim() === "") return "vi";
  return appLocale.trim().toLowerCase().startsWith("vi") ? "vi" : "en";
}

/**
 * The menu follows the language chosen in the app (`rakazo.uiLocale` in web localStorage), and
 * Vietnamese until one is saved, like the web resolver. The operating system language never
 * decides it, so an English Windows or Linux does not get an English menu around a Vietnamese app.
 */
export function localeFromSavedChoice(saved: unknown): Locale {
  if (typeof saved !== "string" || saved.trim() === "") return "vi";
  const tag = saved.trim().toLowerCase();
  // The web app moves these retired catalogs to Vietnamese.
  if (/^(vi|ja|ko|zh)(-|$)/.test(tag)) return "vi";
  return "en";
}

export function setLocale(appLocale: string | undefined): Locale {
  active = resolveLocale(appLocale);
  return active;
}

export function currentLocale(): Locale {
  return active;
}

export function strings(): Strings {
  return DICTIONARY[active];
}

export function stringsFor(locale: Locale): Strings {
  return DICTIONARY[locale];
}

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
