import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type {
  BrowserActStep,
  ComputerAction,
  PageBrowserCommand,
  PageBrowserResult,
} from "@rakazo/adapter-kit";
import { INVALID_BROWSER_REQUEST, SandboxRequestRejectedError } from "@rakazo/adapter-kit";
import { abortableDelay, pollUntil } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { DomStepPlan, EvaluatedDomSnapshot } from "./desktop-browser-dom.js";
import {
  buildDomSnapshotExpression,
  buildPrepareActStepExpression,
  buildPurchaseCheckExpression,
} from "./desktop-browser-dom.js";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import type { MinimalWebSocket } from "./desktop-ws.js";

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 800;

export function detectNativeBrowserExecutable(
  overridePath?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: string[] = [];
  const envOverride = overridePath?.trim() || env.VNBOT_DESKTOP_BROWSER_PATH?.trim();
  if (envOverride) {
    candidates.push(envOverride);
  }

  if (platform === "win32") {
    const roots = [
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      env.LOCALAPPDATA,
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ].filter((item): item is string => Boolean(item?.trim()));
    const suffixes = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["Chromium", "Application", "chrome.exe"],
    ];
    for (const root of roots) {
      for (const suffix of suffixes) {
        candidates.push(path.win32.join(root, ...suffix));
      }
    }
  } else if (platform === "darwin") {
    const homeApps = path.join(homedir(), "Applications");
    const appRoots = ["/Applications", homeApps];
    const appBundles = [
      ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"],
      ["Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"],
      ["Brave Browser.app", "Contents", "MacOS", "Brave Browser"],
      ["Chromium.app", "Contents", "MacOS", "Chromium"],
    ];
    for (const root of appRoots) {
      for (const bundle of appBundles) {
        candidates.push(path.join(root, ...bundle));
      }
    }
  } else {
    const linuxBins = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
      "/snap/bin/chromium",
    ];
    candidates.push(...linuxBins);
    const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    const binNames = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "brave-browser",
    ];
    for (const dir of pathDirs) {
      for (const name of binNames) {
        candidates.push(path.join(dir, name));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* ignore inaccessible path */
    }
  }
  return null;
}

export function normalizeNavigationUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "about:blank";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function safeBotFolderName(botId: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(botId)) return botId;
  return createHash("sha256").update(botId).digest("hex");
}

export function tokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface CdpTargetInfo {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface ConnectedScreenClient {
  ws: MinimalWebSocket;
  mode: "view" | "control";
  token: string;
}

export interface KeyDescriptor {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const KEY_DESCRIPTORS: Record<string, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

export function describeKey(rawKey: string, rawCode?: string): KeyDescriptor {
  const known = KEY_DESCRIPTORS[rawKey];
  if (known) {
    return rawCode ? { ...known, code: rawCode } : known;
  }
  if (rawKey.length === 1) {
    const upper = rawKey.toUpperCase();
    const charCode = upper.charCodeAt(0);
    const inferredCode =
      rawCode ||
      (charCode >= 65 && charCode <= 90
        ? `Key${upper}`
        : charCode >= 48 && charCode <= 57
          ? `Digit${rawKey}`
          : "");
    return {
      key: rawKey,
      code: inferredCode,
      keyCode: charCode,
      text: rawKey,
    };
  }
  return {
    key: rawKey,
    code: rawCode || rawKey,
    keyCode: 0,
  };
}

export function cdpModifiersMask(modifiers?: readonly string[]): number {
  if (!modifiers || modifiers.length === 0) return 0;
  let mask = 0;
  for (const mod of modifiers) {
    const norm = mod.toLowerCase();
    if (norm === "alt" || norm === "option") mask |= 1;
    else if (norm === "control" || norm === "ctrl") mask |= 2;
    else if (norm === "meta" || norm === "command" || norm === "cmd" || norm === "super") mask |= 4;
    else if (norm === "shift") mask |= 8;
  }
  return mask;
}

export class CdpPageConnection {
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly eventListeners = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();

  constructor(
    readonly targetId: string,
    readonly ws: MinimalWebSocket,
  ) {
    ws.onMessage((text) => {
      let msg: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(String(msg.error.message || "CDP command failed")));
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }
      if (typeof msg.method === "string") {
        const listeners = this.eventListeners.get(msg.method);
        if (listeners) {
          for (const fn of listeners) {
            try {
              fn(msg.params ?? {});
            } catch {
              /* ignore event listener error */
            }
          }
        }
      }
    });
    ws.onClose(() => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  get open(): boolean {
    return this.ws.open;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    if (!this.ws.open) {
      return Promise.reject(new Error("CDP connection is not open"));
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout waiting for ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    let set = this.eventListeners.get(method);
    if (!set) {
      set = new Set();
      this.eventListeners.set(method, set);
    }
    set.add(listener);
  }

  close(): void {
    this.ws.close();
  }
}

export async function dispatchCdpKey(
  cdp: CdpPageConnection,
  rawKey: string,
  rawCode?: string,
  modifiers?: readonly string[],
): Promise<void> {
  const desc = describeKey(rawKey, rawCode);
  const modMask = cdpModifiersMask(modifiers);
  await cdp.send("Input.dispatchKeyEvent", {
    type: desc.text && modMask === 0 ? "keyDown" : "rawKeyDown",
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.keyCode,
    nativeVirtualKeyCode: desc.keyCode,
    modifiers: modMask,
    ...(desc.text && modMask === 0 ? { text: desc.text, unmodifiedText: desc.text } : {}),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: desc.key,
    code: desc.code,
    windowsVirtualKeyCode: desc.keyCode,
    nativeVirtualKeyCode: desc.keyCode,
    modifiers: modMask,
  });
}

export async function executeCdpComputerAction(
  cdp: CdpPageConnection,
  action: ComputerAction,
  bounds: { width: number; height: number },
  callbacks: {
    onCursor: (pt: { x: number; y: number }) => void;
    onNavigate: (url: string) => Promise<void>;
  },
): Promise<void> {
  switch (action.kind) {
    case "pointer": {
      const x = Math.max(0, Math.min(bounds.width - 1, Math.round(action.x)));
      const y = Math.max(0, Math.min(bounds.height - 1, Math.round(action.y)));
      callbacks.onCursor({ x, y });
      const button = action.button === "right" ? "right" : "left";
      if (action.type === "move") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      } else if (action.type === "down") {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          clickCount: 1,
        });
      } else if (action.type === "up") {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          clickCount: 1,
        });
      } else if (action.type === "click") {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          clickCount: 1,
        });
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          clickCount: 1,
        });
      }
      break;
    }
    case "key": {
      await dispatchCdpKey(cdp, action.key, undefined, action.modifiers);
      break;
    }
    case "clipboard": {
      await cdp.send("Input.insertText", { text: action.text });
      break;
    }
    case "scroll": {
      const x = Math.round(action.x ?? bounds.width / 2);
      const y = Math.round(action.y ?? bounds.height / 2);
      const step = Math.max(40, Math.round((action.amount ?? 3) * 100));
      const deltaX = action.direction === "left" ? -step : action.direction === "right" ? step : 0;
      const deltaY = action.direction === "up" ? -step : action.direction === "down" ? step : 0;
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
      break;
    }
    case "wait": {
      const ms = Math.max(0, Math.min(5_000, Math.round(action.ms)));
      await abortableDelay(ms);
      break;
    }
    case "open": {
      if (action.path) {
        await callbacks.onNavigate(action.path);
      }
      break;
    }
    case "launch":
    case "focus": {
      if (action.uri) {
        await callbacks.onNavigate(action.uri);
      }
      break;
    }
  }
}

export async function evaluateCdpDomSnapshot(
  cdp: CdpPageConnection,
  fallbackUrl: string,
  fallbackTitle: string,
  query?: string,
): Promise<EvaluatedDomSnapshot> {
  const evalRes = await cdp.send<{ result?: { value?: EvaluatedDomSnapshot } }>(
    "Runtime.evaluate",
    {
      expression: buildDomSnapshotExpression(query),
      returnByValue: true,
    },
  );
  return (
    evalRes.result?.value ?? {
      url: fallbackUrl,
      title: fallbackTitle,
      loading: false,
      tree: "(no interactive elements)",
      elements: [],
    }
  );
}

export async function executeCdpBrowserActStep(
  cdp: CdpPageConnection,
  step: BrowserActStep,
  workspaceHome: string,
  onClickPoint: (x: number, y: number) => Promise<void>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const evalRes = await cdp.send<{ result?: { value?: DomStepPlan } }>("Runtime.evaluate", {
    expression: buildPrepareActStepExpression(step),
    returnByValue: true,
  });
  const plan = evalRes.result?.value;
  if (!plan) {
    return { ok: false, error: "Browser page could not evaluate the step." };
  }
  if (plan.status === "stale" || plan.status === "refused") {
    return { ok: false, error: plan.error || "Action refused by page." };
  }
  if (plan.status === "click_point" && typeof plan.x === "number" && typeof plan.y === "number") {
    await onClickPoint(plan.x, plan.y);
    return { ok: true };
  }
  if (plan.status === "upload_ready" && step.kind === "upload" && plan.selector) {
    const resolvedFiles: string[] = [];
    const allowedRoots = [workspaceHome, ...(Array.isArray(step.roots) ? step.roots : [])];
    for (const rawPath of step.paths) {
      const candidate = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(workspaceHome, rawPath);
      if (!isAllowedDesktopPath(candidate, allowedRoots)) {
        return { ok: false, error: "Upload file path is outside the allowed workspace." };
      }
      resolvedFiles.push(candidate);
    }
    const doc = await cdp.send<{ root?: { nodeId?: number } }>("DOM.getDocument", { depth: 1 });
    const rootNodeId = doc.root?.nodeId;
    if (!rootNodeId) {
      return { ok: false, error: "Could not inspect DOM document for upload." };
    }
    const node = await cdp.send<{ nodeId?: number }>("DOM.querySelector", {
      nodeId: rootNodeId,
      selector: plan.selector,
    });
    if (!node.nodeId) {
      return { ok: false, error: "Upload input element is no longer attached." };
    }
    await cdp.send("DOM.setFileInputFiles", {
      nodeId: node.nodeId,
      files: resolvedFiles,
    });
    return { ok: true };
  }
  if (plan.status === "applied") {
    if (plan.typeText) {
      await cdp.send("Input.insertText", { text: plan.typeText });
    }
    return { ok: true };
  }
  return { ok: false, error: plan.error || "Browser action failed." };
}

export async function runDesktopPageBrowser(
  request: PageBrowserCommand,
  driver: {
    ensureCdpPage: () => Promise<CdpPageConnection>;
    navigate: (url: string, downloads?: string) => Promise<void>;
    configureDownloads: (cdp: CdpPageConnection, downloads?: string) => Promise<void>;
    evaluateSnapshot: (cdp: CdpPageConnection, query?: string) => Promise<EvaluatedDomSnapshot>;
    captureFrame: () => Promise<unknown>;
    waitForSettle: (cdp: CdpPageConnection, ms: number) => Promise<void>;
    executeActStep: (
      cdp: CdpPageConnection,
      step: BrowserActStep,
    ) => Promise<{ ok: true } | { ok: false; error: string }>;
    drainPageMeta: () => Record<string, unknown>;
    fallbackState: () => { url: string; title: string };
  },
): Promise<PageBrowserResult> {
  if (!request || typeof request !== "object" || !("command" in request)) {
    throw new SandboxRequestRejectedError();
  }

  try {
    const cdp = await driver.ensureCdpPage();

    if (request.command === "navigate") {
      if (typeof request.url !== "string" || !request.url.trim()) {
        throw new SandboxRequestRejectedError();
      }
      await driver.navigate(request.url, request.downloads);
      const snap = await driver.evaluateSnapshot(cdp);
      return {
        ok: true,
        url: snap.url,
        title: snap.title,
        loading: snap.loading,
        tree: snap.tree,
        elements: snap.elements,
        ...driver.drainPageMeta(),
      };
    }

    if (request.command === "snapshot") {
      await driver.configureDownloads(cdp, request.downloads);
      const snap = await driver.evaluateSnapshot(cdp, request.query);
      await driver.captureFrame();
      return {
        ok: true,
        url: snap.url,
        title: snap.title,
        loading: snap.loading,
        tree: snap.tree,
        elements: snap.elements,
        ...driver.drainPageMeta(),
      };
    }

    if (request.command === "purchase_check") {
      const evalRes = await cdp.send<{
        result?: { value?: { ok: boolean; site?: string; purchase: unknown } };
      }>("Runtime.evaluate", {
        expression: buildPurchaseCheckExpression(request),
        returnByValue: true,
      });
      const val = evalRes.result?.value ?? { ok: true, purchase: null };
      return {
        ok: true,
        ...(val.site ? { site: val.site } : {}),
        purchase: val.purchase ?? null,
      };
    }

    if (request.command === "act") {
      if (!Array.isArray(request.actions) || request.actions.length === 0) {
        throw new SandboxRequestRejectedError();
      }
      await driver.configureDownloads(cdp, request.downloads);
      let completed = 0;

      for (const step of request.actions) {
        const stepResult = await driver.executeActStep(cdp, step);
        if (!stepResult.ok) {
          const snap = await driver.evaluateSnapshot(cdp);
          await driver.captureFrame();
          return {
            ok: false,
            completed,
            uncertain: false,
            error: stepResult.error,
            url: snap.url,
            title: snap.title,
            loading: snap.loading,
            tree: snap.tree,
            elements: snap.elements,
            ...driver.drainPageMeta(),
          };
        }
        completed += 1;
      }

      await driver.waitForSettle(cdp, 1_200);
      const snap = await driver.evaluateSnapshot(cdp);
      await driver.captureFrame();
      return {
        ok: true,
        completed,
        url: snap.url,
        title: snap.title,
        loading: snap.loading,
        tree: snap.tree,
        elements: snap.elements,
        ...driver.drainPageMeta(),
      };
    }

    throw new SandboxRequestRejectedError();
  } catch (error) {
    if (error instanceof SandboxRequestRejectedError) throw error;
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : INVALID_BROWSER_REQUEST;
    const state = driver.fallbackState();
    return {
      ok: false,
      completed: 0,
      uncertain: false,
      fallback: "computer_act",
      url: state.url,
      title: state.title,
      error: message,
    };
  }
}

export async function launchChromiumProcess(opts: {
  executable: string;
  profileDir: string;
  workspaceHome: string;
  windowed: boolean;
  startUrl: string;
  onSpawned: (proc: ChildProcess) => void;
  onStartupFailed: () => Promise<void>;
}): Promise<{ proc: ChildProcess; port: number }> {
  await mkdir(opts.profileDir, { recursive: true });
  // Remove stale Chromium singleton locks if a previous process crashed.
  await Promise.all([
    bestEffort(
      "remove Chromium SingletonLock",
      rm(path.join(opts.profileDir, "SingletonLock"), { force: true }),
    ),
    bestEffort(
      "remove Chromium SingletonCookie",
      rm(path.join(opts.profileDir, "SingletonCookie"), { force: true }),
    ),
    bestEffort(
      "remove Chromium SingletonSocket",
      rm(path.join(opts.profileDir, "SingletonSocket"), { force: true }),
    ),
  ]);

  const args = [
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-popup-blocking",
    `--window-size=${DEFAULT_WIDTH},${DEFAULT_HEIGHT}`,
    ...(opts.windowed
      ? []
      : ["--headless=new", "--hide-scrollbars", "--mute-audio", "--disable-gpu"]),
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    opts.startUrl,
  ];

  const proc = spawn(opts.executable, args, {
    cwd: opts.workspaceHome,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: !opts.windowed,
  });
  opts.onSpawned(proc);

  const port = await new Promise<number>((resolve, reject) => {
    let stderrText = "";
    const timer = setTimeout(() => {
      reject(
        new Error(`Timed out waiting for browser DevTools endpoint (${stderrText.slice(0, 180)})`),
      );
    }, 12_000);
    timer.unref();

    const onData = (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
      const match = stderrText.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match?.[1]) {
        clearTimeout(timer);
        proc.stderr?.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    proc.stderr?.on("data", onData);
    proc.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser exited before DevTools started (code ${code ?? "null"})`));
    });
  }).catch(async (error) => {
    await opts.onStartupFailed();
    throw error;
  });

  return { proc, port };
}

/**
 * When a user hits Google's automated-browser rejection page in headless mode and switches to an
 * external Chrome window, send them to the fresh Google sign-in page instead of the dead error URL.
 */
export function normalizeCleanSignInUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed === "about:blank") return "about:blank";
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.hostname.toLowerCase() === "accounts.google.com" &&
      /\/signin\/rejected\b/i.test(parsed.pathname)
    ) {
      return "https://accounts.google.com/";
    }
  } catch {
    /* keep original URL */
  }
  return trimmed;
}

/**
 * Launches the user's native browser as a clean stock window (no headless, no remote debugging port,
 * no sync suppression) sharing the bot's profile directory so Google/2FA/passkey sign-in passes.
 */
export async function launchCleanBrowserWindow(opts: {
  executable: string;
  profileDir: string;
  workspaceHome: string;
  startUrl: string;
  onSpawned: (proc: ChildProcess) => void;
}): Promise<{ proc: ChildProcess }> {
  await mkdir(opts.profileDir, { recursive: true });
  await Promise.all([
    bestEffort(
      "remove Chromium SingletonLock",
      rm(path.join(opts.profileDir, "SingletonLock"), { force: true }),
    ),
    bestEffort(
      "remove Chromium SingletonCookie",
      rm(path.join(opts.profileDir, "SingletonCookie"), { force: true }),
    ),
    bestEffort(
      "remove Chromium SingletonSocket",
      rm(path.join(opts.profileDir, "SingletonSocket"), { force: true }),
    ),
  ]);

  const args = [
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${DEFAULT_WIDTH},${DEFAULT_HEIGHT}`,
    ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
    normalizeCleanSignInUrl(opts.startUrl),
  ];

  const proc = spawn(opts.executable, args, {
    cwd: opts.workspaceHome,
    stdio: "ignore",
    windowsHide: false,
  });
  opts.onSpawned(proc);
  return { proc };
}

/**
 * Gracefully asks a browser process to close so SQLite cookies flush to disk before falling back to
 * hard termination. On Windows, `taskkill /PID` (without `/F`) sends WM_CLOSE to windowed Chrome.
 */
export async function gracefulCloseBrowserProcess(
  proc: ChildProcess,
  preferGracefulWindowClose: boolean,
): Promise<void> {
  if (proc.exitCode !== null || proc.killed) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  if (process.platform === "win32" && preferGracefulWindowClose && typeof proc.pid === "number") {
    try {
      spawn("taskkill", ["/PID", String(proc.pid)], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  } else {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  const waitMs = preferGracefulWindowClose ? 2_500 : 1_500;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
        resolve();
      }, waitMs).unref();
    }),
  ]);
}

export async function readWindowedLayoutViewport(
  cdp: CdpPageConnection,
): Promise<{ width?: number; height?: number } | null> {
  const metrics = await bestEffort(
    "read CDP layout metrics",
    cdp.send<{
      cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
      layoutViewport?: { clientWidth?: number; clientHeight?: number };
    }>("Page.getLayoutMetrics"),
  );
  const vp = metrics?.cssLayoutViewport ?? metrics?.layoutViewport;
  if (!vp) return null;
  return {
    ...(typeof vp.clientWidth === "number" && vp.clientWidth > 0
      ? { width: Math.round(vp.clientWidth) }
      : {}),
    ...(typeof vp.clientHeight === "number" && vp.clientHeight > 0
      ? { height: Math.round(vp.clientHeight) }
      : {}),
  };
}

export async function waitForCdpPageSettle(
  cdp: CdpPageConnection,
  maxWaitMs = 2_500,
): Promise<void> {
  const settled = await pollUntil(
    async () => {
      const res = await bestEffort(
        "check CDP document.readyState",
        cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        }),
      );
      return res?.result?.value === "complete" || res?.result?.value === "interactive"
        ? true
        : undefined;
    },
    {
      intervalMs: 100,
      timeoutMs: maxWaitMs,
      onTimeout: () => false,
    },
  );
  if (settled) {
    await abortableDelay(120);
  }
}
