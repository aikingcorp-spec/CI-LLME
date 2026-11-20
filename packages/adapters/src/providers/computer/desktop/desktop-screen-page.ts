export function renderDesktopScreenHtml(): string {
  return `<!DOCTYPE html>
<html lang="vi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>VNBot Browser Screen</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0e0e10;
        --bar-bg: #151518;
        --bar-border: rgba(255, 255, 255, 0.08);
        --field-bg: #1e1e23;
        --field-border: rgba(255, 255, 255, 0.1);
        --field-focus: rgba(255, 255, 255, 0.24);
        --ink: #f4f4f6;
        --muted: #9ca3af;
        --hover: rgba(255, 255, 255, 0.07);
        --pill-active: rgba(255, 255, 255, 0.13);
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: var(--bg);
        color: var(--ink);
        font: 400 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
        overflow: hidden;
        user-select: none;
      }
      #app {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
      }
      #toolbar {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 40px;
        padding: 0 10px;
        background: var(--bar-bg);
        border-bottom: 1px solid var(--bar-border);
        flex-shrink: 0;
        z-index: 3;
      }
      #toolbar[hidden] {
        display: none !important;
      }
      .icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        flex-shrink: 0;
        transition: background 120ms ease, color 120ms ease;
      }
      .icon-btn:hover:not(:disabled) {
        background: var(--hover);
        color: var(--ink);
      }
      .icon-btn:disabled {
        opacity: 0.35;
        cursor: default;
      }
      .icon-btn svg {
        width: 15px;
        height: 15px;
      }
      #tab-select {
        max-width: 150px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--field-border);
        border-radius: 7px;
        background: var(--field-bg);
        color: var(--ink);
        font: inherit;
        font-size: 12px;
        outline: none;
        cursor: pointer;
      }
      #tab-select[hidden] {
        display: none !important;
      }
      #url-form {
        flex: 1;
        min-width: 0;
        display: flex;
      }
      #url-input {
        width: 100%;
        height: 28px;
        padding: 0 10px;
        border: 1px solid var(--field-border);
        border-radius: 7px;
        background: var(--field-bg);
        color: var(--ink);
        font: inherit;
        font-size: 12.5px;
        outline: none;
        user-select: text;
        transition: border-color 120ms ease;
      }
      #url-input:focus {
        border-color: var(--field-focus);
      }
      #url-input::placeholder {
        color: var(--muted);
      }
      #window-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border: 1px solid var(--field-border);
        border-radius: 7px;
        background: var(--field-bg);
        color: var(--ink);
        font: 500 12px/1 inherit;
        white-space: nowrap;
        cursor: pointer;
        flex-shrink: 0;
        transition: background 120ms ease, border-color 120ms ease;
      }
      #window-btn:hover:not(:disabled) {
        background: var(--pill-active);
      }
      #window-btn[data-active="true"] {
        background: var(--pill-active);
        border-color: var(--field-focus);
      }
      #window-btn:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      #window-btn svg {
        width: 13.5px;
        height: 13.5px;
        color: var(--muted);
      }
      #screen {
        position: relative;
        flex: 1;
        min-height: 0;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg);
        overflow: hidden;
      }
      #viewport {
        display: block;
        background: #ffffff;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
        outline: none;
        cursor: default;
      }
      #viewport[hidden] {
        display: none !important;
      }
      #empty-state {
        max-width: 400px;
        padding: 24px;
        text-align: center;
        color: var(--muted);
      }
      #empty-state[hidden] {
        display: none !important;
      }
      #empty-title {
        margin: 0 0 6px;
        color: var(--ink);
        font-size: 14px;
        font-weight: 500;
      }
      #empty-desc {
        margin: 0 0 14px;
        font-size: 13px;
        line-height: 1.5;
      }
      #retry-btn,
      #dock-btn,
      #signin-open-btn {
        height: 30px;
        padding: 0 14px;
        border: 1px solid var(--field-border);
        border-radius: 8px;
        background: var(--field-bg);
        color: var(--ink);
        font: 500 12.5px/1 inherit;
        cursor: pointer;
        white-space: nowrap;
      }
      #retry-btn:hover,
      #dock-btn:hover,
      #signin-open-btn:hover {
        background: var(--pill-active);
      }
      #retry-btn[hidden],
      #dock-btn[hidden] {
        display: none !important;
      }
      #signin-banner {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 14px;
        background: var(--bar-bg);
        border-bottom: 1px solid var(--bar-border);
        color: var(--muted);
        font-size: 12.5px;
      }
      #signin-banner[hidden] {
        display: none !important;
      }
      #signin-banner-text {
        min-width: 0;
        flex: 1;
      }
      #sync-badge {
        position: absolute;
        right: 12px;
        bottom: 12px;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(21, 21, 24, 0.86);
        border: 1px solid var(--bar-border);
        color: var(--muted);
        font-size: 11.5px;
        pointer-events: none;
        backdrop-filter: blur(8px);
      }
      #sync-badge[hidden] {
        display: none !important;
      }
      #ime-input {
        position: fixed;
        left: -9999px;
        top: 0;
        width: 1px;
        height: 1px;
        opacity: 0;
        border: 0;
        padding: 0;
        outline: none;
      }
    </style>
  </head>
  <body>
    <div id="app">
      <div id="toolbar" hidden>
        <button id="back-btn" class="icon-btn" type="button" aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <button id="forward-btn" class="icon-btn" type="button" aria-label="Forward">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <button id="reload-btn" class="icon-btn" type="button" aria-label="Reload">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
        <select id="tab-select" aria-label="Tabs" hidden></select>
        <button id="new-tab-btn" class="icon-btn" type="button" aria-label="New tab">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <form id="url-form">
          <input id="url-input" type="text" spellcheck="false" autocomplete="off" />
        </form>
        <button id="window-btn" type="button" data-active="false">
          <svg id="window-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          <span id="window-label"></span>
        </button>
      </div>
      <div id="signin-banner" hidden>
        <span id="signin-banner-text"></span>
        <button id="signin-open-btn" type="button"></button>
      </div>
      <div id="screen">
        <canvas id="viewport" tabindex="0" hidden></canvas>
        <div id="empty-state" hidden>
          <p id="empty-title"></p>
          <p id="empty-desc"></p>
          <button id="retry-btn" type="button"></button>
          <button id="dock-btn" type="button" hidden></button>
        </div>
        <div id="sync-badge" hidden></div>
      </div>
    </div>
    <textarea id="ime-input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" tabindex="-1" aria-hidden="true"></textarea>
    <script>
      (() => {
        function buildCopy(vi) {
          return vi
            ? {
                placeholder: "Nhập địa chỉ trang web (ví dụ: accounts.google.com)…",
                openExternal: "Mở cửa sổ ngoài",
                dockInApp: "Thu về trong app",
                switching: "Đang chuyển…",
                syncedBadge: "Đang mở cửa sổ ngoài · Cookie tự động lưu",
                noBrowserTitle: "Chưa tìm thấy Chrome hoặc Edge",
                noBrowserDesc:
                  "Cài đặt Google Chrome, Microsoft Edge hoặc Brave trên máy tính để sử dụng màn hình trình duyệt ảo.",
                readyTitle: "Trình duyệt riêng của trợ lý đã sẵn sàng",
                readyDescControl:
                  "Nhập địa chỉ trang web trên thanh công cụ phía trên hoặc bấm Mở cửa sổ ngoài để đăng nhập.",
                readyDescView:
                  "Chưa mở trang web nào. Bấm Tiếp quản để mở trang web hoặc yêu cầu trợ lý truy cập.",
                externalTitle: "Đang mở cửa sổ Chrome ngoài để đăng nhập",
                externalDesc:
                  "Hãy đăng nhập tài khoản trên cửa sổ Chrome vừa mở. Khi xong, đóng cửa sổ Chrome (hoặc bấm Thu về trong app) — phiên đăng nhập sẽ tự động lưu cho trợ lý.",
                googleSignInHint:
                  "Google chặn đăng nhập trong khung nhúng. Mở cửa sổ ngoài để đăng nhập bằng Chrome thật.",
                retry: "Kiểm tra lại",
                back: "Quay lại",
                forward: "Tiếp theo",
                reload: "Tải lại",
                newTab: "Thẻ mới",
              }
            : {
                placeholder: "Enter website address (e.g. accounts.google.com)…",
                openExternal: "Open window",
                dockInApp: "Dock in app",
                switching: "Switching…",
                syncedBadge: "External window open · Cookies stay synced",
                noBrowserTitle: "Chrome or Edge not found",
                noBrowserDesc:
                  "Install Google Chrome, Microsoft Edge, or Brave on this computer to use the virtual browser screen.",
                readyTitle: "Assistant browser is ready",
                readyDescControl:
                  "Enter a website address in the toolbar above or click Open window to sign in.",
                readyDescView:
                  "No webpage open yet. Click Take control to open a site or ask the assistant to browse.",
                externalTitle: "External Chrome window open for sign-in",
                externalDesc:
                  "Sign in using the Chrome window that just opened. When done, close Chrome (or click Dock in app) — your session stays saved for the assistant.",
                googleSignInHint:
                  "Google blocks sign-in in embedded mode. Open an external Chrome window to sign in.",
                retry: "Check again",
                back: "Back",
                forward: "Forward",
                reload: "Reload",
                newTab: "New tab",
              };
        }

        function isGoogleSignInUrl(url) {
          if (typeof url !== "string" || !url) return false;
          try {
            const parsed = new URL(url);
            return parsed.hostname.toLowerCase() === "accounts.google.com";
          } catch {
            return false;
          }
        }

        let copy = buildCopy(/^vi\\b/i.test(navigator.language || ""));

        function query(name, fallback) {
          const match = (document.location.href + window.location.hash).match(
            new RegExp(".*[?&]" + name + "=([^&#]*)"),
          );
          return match ? decodeURIComponent(match[1]) : fallback;
        }
        function flag(name) {
          const value = String(query(name, "false")).toLowerCase();
          return value === "1" || value === "true" || value === "yes";
        }

        const viewOnlyParam = query("view_only", null);
        const modeParam = String(query("mode", "")).toLowerCase();
        const viewOnly =
          modeParam === "view" ||
          (viewOnlyParam !== null ? flag("view_only") : modeParam !== "control");
        const root = document.documentElement;
        root.classList.add("noVNC_connecting");

        const toolbar = document.getElementById("toolbar");
        const backBtn = document.getElementById("back-btn");
        const forwardBtn = document.getElementById("forward-btn");
        const reloadBtn = document.getElementById("reload-btn");
        const tabSelect = document.getElementById("tab-select");
        const newTabBtn = document.getElementById("new-tab-btn");
        const urlForm = document.getElementById("url-form");
        const urlInput = document.getElementById("url-input");
        const windowBtn = document.getElementById("window-btn");
        const windowLabel = document.getElementById("window-label");
        const signInBanner = document.getElementById("signin-banner");
        const signInBannerText = document.getElementById("signin-banner-text");
        const signInOpenBtn = document.getElementById("signin-open-btn");
        const screenEl = document.getElementById("screen");
        const canvas = document.getElementById("viewport");
        const ctx = canvas.getContext("2d", { alpha: false });
        const emptyState = document.getElementById("empty-state");
        const emptyTitle = document.getElementById("empty-title");
        const emptyDesc = document.getElementById("empty-desc");
        const retryBtn = document.getElementById("retry-btn");
        const dockBtn = document.getElementById("dock-btn");
        const syncBadge = document.getElementById("sync-badge");
        const imeInput = document.getElementById("ime-input");

        let remoteWidth = 1280;
        let remoteHeight = 800;
        let currentWindowed = false;
        let currentCleanWindow = false;
        let currentUrl = "about:blank";
        let browserOk = true;
        let lastBrowserError = "";
        let switchingWindow = false;
        let lastFrameImg = null;
        let composing = false;
        let lastTabsKey = "";

        function updateSignInBanner() {
          signInBanner.hidden = viewOnly || currentWindowed || !browserOk || !isGoogleSignInUrl(currentUrl);
        }

        function updateEmptyAndCanvas(customError) {
          if (typeof customError === "string") lastBrowserError = customError;
          updateSignInBanner();
          if (!browserOk) {
            canvas.hidden = true;
            emptyState.hidden = false;
            retryBtn.hidden = false;
            dockBtn.hidden = true;
            emptyTitle.textContent = copy.noBrowserTitle;
            emptyDesc.textContent = lastBrowserError || copy.noBrowserDesc;
            return;
          }
          if (currentWindowed && currentCleanWindow) {
            canvas.hidden = true;
            emptyState.hidden = false;
            retryBtn.hidden = true;
            dockBtn.hidden = viewOnly;
            emptyTitle.textContent = copy.externalTitle;
            emptyDesc.textContent = copy.externalDesc;
            return;
          }
          if (!currentWindowed && (!currentUrl || currentUrl === "about:blank")) {
            canvas.hidden = true;
            emptyState.hidden = false;
            retryBtn.hidden = true;
            dockBtn.hidden = true;
            emptyTitle.textContent = copy.readyTitle;
            emptyDesc.textContent = viewOnly ? copy.readyDescView : copy.readyDescControl;
            return;
          }
          emptyState.hidden = true;
          canvas.hidden = false;
        }

        function updateWindowBtn() {
          windowBtn.dataset.active = currentWindowed ? "true" : "false";
          windowBtn.disabled = switchingWindow;
          dockBtn.disabled = switchingWindow;
          signInOpenBtn.disabled = switchingWindow;
          windowLabel.textContent = switchingWindow
            ? copy.switching
            : currentWindowed
              ? copy.dockInApp
              : copy.openExternal;
          syncBadge.hidden = !currentWindowed || currentCleanWindow;
        }

        function applyCopy() {
          urlInput.placeholder = copy.placeholder;
          backBtn.title = copy.back;
          forwardBtn.title = copy.forward;
          reloadBtn.title = copy.reload;
          newTabBtn.title = copy.newTab;
          retryBtn.textContent = copy.retry;
          dockBtn.textContent = copy.dockInApp;
          signInBannerText.textContent = copy.googleSignInHint;
          signInOpenBtn.textContent = copy.openExternal;
          syncBadge.textContent = copy.syncedBadge;
          updateWindowBtn();
          updateEmptyAndCanvas();
        }
        toolbar.hidden = viewOnly;
        applyCopy();

        if (typeof window.addEventListener === "function") {
          window.addEventListener("message", (event) => {
            const data = event && event.data;
            if (!data || typeof data !== "object" || typeof data.rakazoScreenLang !== "string") return;
            copy = buildCopy(/^vi\\b/i.test(data.rakazoScreenLang));
            applyCopy();
          });
        }

        function layoutCanvas() {
          const rect = screenEl.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          const scale = Math.min(rect.width / remoteWidth, rect.height / remoteHeight);
          const cssW = Math.max(1, Math.round(remoteWidth * scale));
          const cssH = Math.max(1, Math.round(remoteHeight * scale));
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.style.width = cssW + "px";
          canvas.style.height = cssH + "px";
          const targetW = Math.max(1, Math.round(cssW * dpr));
          const targetH = Math.max(1, Math.round(cssH * dpr));
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          if (lastFrameImg) {
            ctx.drawImage(lastFrameImg, 0, 0, canvas.width, canvas.height);
          }
        }
        new ResizeObserver(layoutCanvas).observe(screenEl);

        const wsPath = String(query("path", "websockify")).replace(/^\\//, "");
        const prefix = window.location.pathname.replace(/[^/]+$/, "");
        const protocol = window.location.protocol === "https:" ? "wss" : "ws";
        const wsUrl = protocol + "://" + window.location.host + prefix + wsPath;
        const ws = new WebSocket(wsUrl);

        function send(payload) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
          }
        }

        function markConnected() {
          if (!root.classList.contains("noVNC_connected")) {
            root.classList.remove("noVNC_connecting");
            root.classList.add("noVNC_connected");
          }
        }

        ws.addEventListener("message", (event) => {
          let msg;
          try {
            msg = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (msg.type === "state") {
            markConnected();
            browserOk = msg.browserAvailable !== false;
            if (!browserOk) {
              updateEmptyAndCanvas(msg.error || "");
              return;
            }
            lastBrowserError = "";
            if (typeof msg.width === "number" && msg.width > 0) remoteWidth = msg.width;
            if (typeof msg.height === "number" && msg.height > 0) remoteHeight = msg.height;
            if (typeof msg.url === "string") currentUrl = msg.url;
            currentWindowed = Boolean(msg.windowed);
            currentCleanWindow = Boolean(msg.cleanWindow);
            switchingWindow = false;
            updateWindowBtn();
            updateEmptyAndCanvas();
            if (document.activeElement !== urlInput && typeof msg.url === "string") {
              urlInput.value = msg.url === "about:blank" ? "" : msg.url;
            }
            if (Array.isArray(msg.tabs)) {
              const nextTabsKey = JSON.stringify(
                msg.tabs.map((tab) => [
                  tab.id,
                  (tab.title || tab.url || "New Tab").slice(0, 42),
                  Boolean(tab.active),
                ]),
              );
              if (nextTabsKey !== lastTabsKey) {
                lastTabsKey = nextTabsKey;
                tabSelect.hidden = msg.tabs.length <= 1;
                tabSelect.innerHTML = "";
                for (const tab of msg.tabs) {
                  const opt = document.createElement("option");
                  opt.value = tab.id;
                  const label = (tab.title || tab.url || "New Tab").slice(0, 42);
                  opt.textContent = label;
                  if (tab.active) opt.selected = true;
                  tabSelect.appendChild(opt);
                }
              }
            }
            layoutCanvas();
            return;
          }
          if (msg.type === "frame" && typeof msg.data === "string") {
            markConnected();
            updateEmptyAndCanvas();
            if (!canvas.hidden) {
              layoutCanvas();
            }
            if (typeof msg.width === "number" && msg.width > 0 && typeof msg.height === "number" && msg.height > 0) {
              if (msg.width !== remoteWidth || msg.height !== remoteHeight) {
                remoteWidth = msg.width;
                remoteHeight = msg.height;
                layoutCanvas();
              }
            }
            const img = new Image();
            img.onload = () => {
              lastFrameImg = img;
              if (!canvas.hidden) {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              }
            };
            img.src = "data:" + (msg.mimeType || "image/jpeg") + ";base64," + msg.data;
          }
        });

        ws.addEventListener("close", (event) => {
          root.classList.remove("noVNC_connecting", "noVNC_connected");
          if (!event.wasClean && !root.hasAttribute("data-rakazo-screen-error")) {
            root.setAttribute("data-rakazo-screen-error", event.reason || "");
          }
        });
        ws.addEventListener("error", () => {
          if (!root.classList.contains("noVNC_connected") && !root.hasAttribute("data-rakazo-screen-error")) {
            root.setAttribute("data-rakazo-screen-error", "connection_failed");
          }
        });

        retryBtn.addEventListener("click", () => send({ type: "retryBrowser" }));

        if (viewOnly) return;

        function focusCanvasInput() {
          try {
            imeInput.focus({ preventScroll: true });
          } catch {}
        }
        canvas.addEventListener("focus", focusCanvasInput);

        backBtn.addEventListener("click", () => {
          send({ type: "nav", action: "back" });
          focusCanvasInput();
        });
        forwardBtn.addEventListener("click", () => {
          send({ type: "nav", action: "forward" });
          focusCanvasInput();
        });
        reloadBtn.addEventListener("click", () => {
          send({ type: "nav", action: "reload" });
          focusCanvasInput();
        });
        newTabBtn.addEventListener("click", () => {
          send({ type: "newTab" });
          urlInput.focus();
          urlInput.select();
        });
        tabSelect.addEventListener("change", () => {
          if (tabSelect.value) send({ type: "activateTab", targetId: tabSelect.value });
          focusCanvasInput();
        });
        function submitUrl() {
          const raw = urlInput.value.trim();
          if (!raw) return;
          send({ type: "navigate", url: raw });
          focusCanvasInput();
        }
        urlInput.addEventListener("focus", () => urlInput.select());
        urlInput.addEventListener("keydown", (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            focusCanvasInput();
          } else if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            submitUrl();
          }
        });
        urlForm.addEventListener("submit", (event) => {
          event.preventDefault();
          submitUrl();
        });
        function toggleExternalWindow(openExternal) {
          if (switchingWindow) return;
          switchingWindow = true;
          updateWindowBtn();
          send({ type: "setWindowMode", windowed: openExternal, clean: openExternal });
        }
        windowBtn.addEventListener("click", () => toggleExternalWindow(!currentWindowed));
        signInOpenBtn.addEventListener("click", () => toggleExternalWindow(true));
        dockBtn.addEventListener("click", () => toggleExternalWindow(false));

        function toRemotePoint(event) {
          const rect = canvas.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
          const x = Math.max(0, Math.min(remoteWidth - 1, Math.round(((event.clientX - rect.left) / rect.width) * remoteWidth)));
          const y = Math.max(0, Math.min(remoteHeight - 1, Math.round(((event.clientY - rect.top) / rect.height) * remoteHeight)));
          return { x, y };
        }
        function buttonName(button) {
          return button === 2 ? "right" : button === 1 ? "middle" : "left";
        }

        let lastMoveAt = 0;
        let clickStreak = 0;
        let lastDownAt = 0;
        let lastDownX = 0;
        let lastDownY = 0;
        let lastDownButton = -1;
        let activeClickCount = 1;
        canvas.addEventListener("pointermove", (event) => {
          const now = performance.now();
          if (now - lastMoveAt < 28) return;
          lastMoveAt = now;
          const pt = toRemotePoint(event);
          send({ type: "mouse", action: "move", x: pt.x, y: pt.y });
        });
        canvas.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          canvas.setPointerCapture?.(event.pointerId);
          focusCanvasInput();
          const now = performance.now();
          if (
            event.button === lastDownButton &&
            now - lastDownAt <= 450 &&
            Math.hypot(event.clientX - lastDownX, event.clientY - lastDownY) <= 6
          ) {
            clickStreak = clickStreak >= 3 ? 1 : clickStreak + 1;
          } else {
            clickStreak = 1;
          }
          lastDownAt = now;
          lastDownX = event.clientX;
          lastDownY = event.clientY;
          lastDownButton = event.button;
          activeClickCount = Math.max(event.detail || 0, clickStreak);
          const pt = toRemotePoint(event);
          send({
            type: "mouse",
            action: "down",
            x: pt.x,
            y: pt.y,
            button: buttonName(event.button),
            clickCount: activeClickCount,
          });
        });
        canvas.addEventListener("pointerup", (event) => {
          event.preventDefault();
          const pt = toRemotePoint(event);
          send({
            type: "mouse",
            action: "up",
            x: pt.x,
            y: pt.y,
            button: buttonName(event.button),
            clickCount: Math.max(event.detail || 0, activeClickCount),
          });
        });
        canvas.addEventListener("contextmenu", (event) => event.preventDefault());
        canvas.addEventListener(
          "wheel",
          (event) => {
            event.preventDefault();
            const pt = toRemotePoint(event);
            send({
              type: "wheel",
              x: pt.x,
              y: pt.y,
              deltaX: Math.round(event.deltaX),
              deltaY: Math.round(event.deltaY),
            });
          },
          { passive: false },
        );

        function modifiersOf(event) {
          const list = [];
          if (event.altKey) list.push("Alt");
          if (event.ctrlKey) list.push("Control");
          if (event.metaKey) list.push("Meta");
          if (event.shiftKey) list.push("Shift");
          return list;
        }

        imeInput.addEventListener("compositionstart", () => {
          composing = true;
        });
        imeInput.addEventListener("compositionend", (event) => {
          composing = false;
          const text = event.data || imeInput.value;
          imeInput.value = "";
          if (text) send({ type: "text", text });
        });
        imeInput.addEventListener("input", () => {
          if (composing) return;
          const text = imeInput.value;
          imeInput.value = "";
          if (text) send({ type: "text", text });
        });
        imeInput.addEventListener("paste", (event) => {
          event.preventDefault();
          const text = event.clipboardData?.getData("text/plain") || "";
          imeInput.value = "";
          if (text) send({ type: "paste", text });
        });
        imeInput.addEventListener("keydown", (event) => {
          if (composing || event.isComposing || event.keyCode === 229) return;
          const hasCmdOrCtrl = event.ctrlKey || event.metaKey;
          // Let native paste fire the paste listener so OS clipboard text reaches the remote page.
          if (hasCmdOrCtrl && !event.altKey && (event.key === "v" || event.key === "V")) {
            return;
          }
          // Printable characters without Ctrl/Meta/Alt flow through the input event (including IME).
          if (event.key.length === 1 && !hasCmdOrCtrl && !event.altKey) {
            return;
          }
          event.preventDefault();
          send({
            type: "key",
            key: event.key,
            code: event.code,
            modifiers: modifiersOf(event),
          });
        });
      })();
    </script>
  </body>
</html>`;
}
