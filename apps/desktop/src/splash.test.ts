// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDesktopLocale } from "./i18n.js";
import { createSplash, SPLASH_CONTACT_URL } from "./splash.js";

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const SPLASH = {
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

afterEach(() => {
  vi.useRealTimers();
  startDesktopLocale(null, "en-US");
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("local launch splash", () => {
  it.each(["vi", "en"] as const)("shows local content before the app, in %s", (locale) => {
    startDesktopLocale(locale, "en-US");
    const openExternal = vi.fn(async () => undefined);
    const callbacks = new Map<string, () => void>();
    const open = vi.fn();
    const navigate = vi.fn();
    class Window {
      webContents = { setWindowOpenHandler: open, on: navigate };
      show = vi.fn();
      isDestroyed = () => false;
      once = (event: string, callback: () => void) => callbacks.set(event, callback);
      loadFile = vi.fn(async () => undefined);
      constructor(readonly options: unknown) {}
    }
    const splash = createSplash(
      Window as unknown as typeof BrowserWindow,
      "linux",
      "/static",
      openExternal,
    ) as unknown as Window;
    expect(splash.options).toMatchObject({
      backgroundColor: "#FFFFFF",
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false },
    });
    expect(splash.loadFile).toHaveBeenCalledWith("/static/splash.html", {
      query: { locale, ...SPLASH[locale] },
    });
    expect(splash.show).not.toHaveBeenCalled();
    callbacks.get("ready-to-show")!();
    expect(splash.show).toHaveBeenCalledOnce();
    const handler = open.mock.calls[0]![0] as (input: { url: string }) => { action: string };
    expect(handler({ url: SPLASH_CONTACT_URL })).toEqual({ action: "deny" });
    handler({ url: "https://example.com/" });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(SPLASH_CONTACT_URL);
    const preventDefault = vi.fn();
    const onNavigate = navigate.mock.calls[0]![1] as (event: {
      preventDefault: () => void;
    }) => void;
    onNavigate({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each(["vi", "en"] as const)(
    "reveals slow and failed %s copy at 10s and 60s without inputs",
    (locale) => {
      vi.useFakeTimers();
      const copy = SPLASH[locale];
      const query = new URLSearchParams({ locale, ...copy });
      window.history.replaceState(null, "", `/?${query}`);
      document.body.innerHTML = new DOMParser().parseFromString(
        source("./splash.html"),
        "text/html",
      ).body.innerHTML;
      new Function(source("./splash-renderer.js"))();
      const hint = document.querySelector<HTMLElement>(".hint")!;
      const contact = document.querySelector<HTMLAnchorElement>("a")!;
      expect(document.querySelector("input, textarea, [contenteditable]")).toBeNull();
      vi.advanceTimersByTime(9_999);
      expect(hint.hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(hint.textContent).toBe(`${copy.slow}\n${copy.starting}`);
      expect(hint.hidden).toBe(false);
      expect(contact.hidden).toBe(true);
      vi.advanceTimersByTime(50_000);
      expect(hint.textContent).toBe(copy.failed);
      expect(contact.textContent).toBe(copy.contact);
      expect(contact.hidden).toBe(false);
      expect(contact.href).toBe(SPLASH_CONTACT_URL);
    },
  );

  it("packages the exact approved asset bytes", () => {
    for (const [file, hash] of [
      ["vnbot-rounded-256.png", "df2c23526195253d64fadfaccc4f31c79eaf21e2b7864fdb563d8235362e4d3d"],
      [
        "vnbot-wordmark-v4-light.svg",
        "1b22b871f49674db423a9c01688d42568b5524e93af570406e177815ab1e48d3",
      ],
    ]) {
      expect(
        createHash("sha256")
          .update(readFileSync(new URL(file, import.meta.url)))
          .digest("hex"),
      ).toBe(hash);
    }
  });
});
