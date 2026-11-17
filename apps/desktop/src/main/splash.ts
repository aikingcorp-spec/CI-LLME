import path from "node:path";
import type { BrowserWindow as ElectronWindow } from "electron";
import { desktopLocale } from "./i18n.js";

export const SPLASH_CONTACT_URL = "https://aikingx.com/lien-he/";

/** Designed splash copy. The screen only has Vietnamese and English. */
const SPLASH_COPY = {
  vi: {
    slow: "Lần mở đầu tiên có thể lâu hơn một chút.",
    starting: "VNBot vẫn đang khởi động.",
    failed: "VNBot chưa mở được. Hãy đóng và mở lại ứng dụng.",
    contact: "Liên hệ",
  },
  en: {
    slow: "The first launch can take a little longer.",
    starting: "VNBot is still starting.",
    failed: "VNBot couldn't start. Close and reopen the app.",
    contact: "Contact",
  },
} as const;

let splashWindow: ElectronWindow | null = null;

/** The designed launch window: light, hidden until its own page is ready. */
export function splashWindowOptions(platform: NodeJS.Platform) {
  const mac = platform === "darwin";
  return {
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: "#FFFFFF",
    show: false,
    autoHideMenuBar: true,
    frame: mac,
    titleBarStyle: mac ? ("hiddenInset" as const) : undefined,
    trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
  };
}

/** The local splash has no preload, IPC, network requests or input controls. */
export function createSplash(
  Window: typeof ElectronWindow,
  platform: NodeJS.Platform,
  directory: string,
  openExternal: (url: string) => Promise<unknown>,
) {
  const win = new Window({
    ...splashWindowOptions(platform),
    title: "VNBot",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  splashWindow = win;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === SPLASH_CONTACT_URL) void openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  const locale = desktopLocale() === "en" ? "en" : "vi";
  void win.loadFile(path.join(directory, "splash.html"), {
    query: { locale, ...SPLASH_COPY[locale] },
  });
  return win;
}

export function dismissSplash() {
  if (splashWindow !== null && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}
