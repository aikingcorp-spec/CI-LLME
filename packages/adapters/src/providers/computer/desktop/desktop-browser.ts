import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type {
  AdapterContext,
  BrowserActStep,
  BrowserDownload,
  ComputerAction,
  ComputerObservation,
  PageBrowserCommand,
  PageBrowserResult,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { abortableDelay, pollUntil } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { computerObservation } from "../../../computer-support.js";
import type { CdpTargetInfo, ConnectedScreenClient } from "./desktop-browser-cdp.js";
import {
  CdpPageConnection,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  detectNativeBrowserExecutable,
  dispatchCdpKey,
  evaluateCdpDomSnapshot,
  executeCdpBrowserActStep,
  executeCdpComputerAction,
  launchChromiumProcess,
  normalizeNavigationUrl,
  readWindowedLayoutViewport,
  runDesktopPageBrowser,
  tokensEqual,
} from "./desktop-browser-cdp.js";
import type { EvaluatedDomSnapshot } from "./desktop-browser-dom.js";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import { renderDesktopScreenHtml } from "./desktop-screen-page.js";
import type { MinimalWebSocket } from "./desktop-ws.js";
import { acceptWebSocketUpgrade, connectLocalWebSocket } from "./desktop-ws.js";

export { detectNativeBrowserExecutable } from "./desktop-browser-cdp.js";
export { DesktopBrowserManager } from "./desktop-browser-manager.js";

export class DesktopBrowserSession {
  private server: http.Server | null = null;
  private serverPort = 0;
  private readonly viewToken = randomBytes(24).toString("hex");
  private controlToken: string | null = null;
  private interactiveAllowed = false;
  private readonly clients = new Set<ConnectedScreenClient>();

  private chromeProcess: ChildProcess | null = null;
  private cdpPort = 0;
  private cdpConnection: CdpPageConnection | null = null;
  private activeTargetId: string | null = null;
  private windowed = false;
  private browserAvailable = true;
  private browserError: string | undefined;
  private currentUrl = "about:blank";
  private currentTitle = "VNBot Browser";
  private tabs: Array<{ id: string; title: string; url: string; active: boolean }> = [];
  private lastFrameBase64: string | null = null;
  private lastFrameBytes: Uint8Array | null = null;
  private lastFrameWidth = DEFAULT_WIDTH;
  private lastFrameHeight = DEFAULT_HEIGHT;
  private lastCursor: { x: number; y: number } | undefined;
  private pendingNotes: string[] = [];
  private openDialogMessage: string | undefined;
  private completedDownloads: BrowserDownload[] = [];
  private activeDownloadsDir: string | null = null;
  private launchPromise: Promise<void> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stoppingProcess = false;
  private launchStartedAt = 0;
  private consecutiveCrashCount = 0;

  constructor(
    readonly computerId: string,
    readonly botId: string,
    readonly workspaceHome: string,
    readonly profileDir: string,
    private readonly executableOverride?: string,
    private readonly listenHostname = "127.0.0.1",
  ) {}

  hasLiveObservation(): boolean {
    return this.lastFrameBytes !== null && this.lastFrameBytes.byteLength > 0;
  }

  latestCachedObservation(): ComputerObservation | null {
    if (!this.lastFrameBytes) return null;
    return computerObservation(this.lastFrameBytes, {
      mimeType: "image/jpeg",
      width: this.lastFrameWidth,
      height: this.lastFrameHeight,
      cursor: this.lastCursor,
      activeWindow: { id: "browser", title: this.currentTitle || this.currentUrl },
    });
  }

  async ensureServer(): Promise<number> {
    if (this.server && this.serverPort > 0) return this.serverPort;
    const srv = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    srv.on("upgrade", (req, socket, head) => {
      this.handleWsUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, this.listenHostname, () => {
        srv.off("error", reject);
        resolve();
      });
    });
    const addr = srv.address() as AddressInfo;
    this.server = srv;
    this.serverPort = addr.port;
    return this.serverPort;
  }

  private authorizeSocketRequest(urlObj: URL): "view" | "control" | null {
    const requestedMode = urlObj.searchParams.get("mode") === "control" ? "control" : "view";
    const token = urlObj.searchParams.get("token") ?? undefined;
    if (requestedMode === "control") {
      if (!this.interactiveAllowed || !this.controlToken) return null;
      return tokensEqual(token, this.controlToken) ? "control" : null;
    }
    if (tokensEqual(token, this.viewToken)) return "view";
    if (this.controlToken && tokensEqual(token, this.controlToken)) return "view";
    return null;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && (reqUrl.pathname === "/embed.html" || reqUrl.pathname === "/")) {
      const html = renderDesktopScreenHtml();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  private handleWsUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (reqUrl.pathname !== "/websockify") {
      socket.destroy();
      return;
    }
    const mode = this.authorizeSocketRequest(reqUrl);
    if (!mode) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ws = acceptWebSocketUpgrade(req, socket, head, 512 * 1024);
    if (!ws) return;

    const client: ConnectedScreenClient = {
      ws,
      mode,
      token: reqUrl.searchParams.get("token") ?? "",
    };
    this.clients.add(client);

    ws.onClose(() => {
      this.clients.delete(client);
    });

    ws.onMessage((raw) => {
      void this.handleClientMessage(client, raw);
    });

    void this.onClientConnected(client);
  }

  private async onClientConnected(client: ConnectedScreenClient): Promise<void> {
    await this.ensureBrowserLaunched().catch((error) => {
      this.browserAvailable = false;
      this.browserError = error instanceof Error ? error.message : String(error);
    });
    this.sendStateTo(client.ws);
    if (this.lastFrameBase64) {
      this.sendFrameTo(client.ws, this.lastFrameBase64);
    } else if (this.browserAvailable) {
      await bestEffort("capture initial desktop browser frame", this.captureAndBroadcastFrame());
    }
  }

  private sendStateTo(ws: MinimalWebSocket): void {
    if (!ws.open) return;
    ws.send(
      JSON.stringify({
        type: "state",
        browserAvailable: this.browserAvailable,
        ...(this.browserError ? { error: this.browserError } : {}),
        url: this.currentUrl,
        title: this.currentTitle,
        windowed: this.windowed,
        width: this.lastFrameWidth,
        height: this.lastFrameHeight,
        tabs: this.tabs,
      }),
    );
  }

  private broadcastState(): void {
    for (const client of this.clients) {
      this.sendStateTo(client.ws);
    }
  }

  private sendFrameTo(ws: MinimalWebSocket, base64: string): void {
    if (!ws.open) return;
    ws.send(
      JSON.stringify({
        type: "frame",
        mimeType: "image/jpeg",
        data: base64,
        width: this.lastFrameWidth,
        height: this.lastFrameHeight,
      }),
    );
  }

  private broadcastFrame(base64: string): void {
    for (const client of this.clients) {
      this.sendFrameTo(client.ws, base64);
    }
  }

  private async handleClientMessage(client: ConnectedScreenClient, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "retryBrowser") {
      this.consecutiveCrashCount = 0;
      await this.ensureBrowserLaunched(true).catch((error) => {
        this.browserAvailable = false;
        this.browserError = error instanceof Error ? error.message : String(error);
      });
      this.broadcastState();
      if (this.browserAvailable) {
        await bestEffort(
          "capture desktop browser frame after retry",
          this.captureAndBroadcastFrame(),
        );
      }
      return;
    }

    // Read-only viewers cannot mutate browser state, send input, or open an external window.
    if (client.mode !== "control" || !this.interactiveAllowed) {
      return;
    }

    try {
      switch (msg.type) {
        case "navigate": {
          if (typeof msg.url === "string") {
            await this.navigate(msg.url);
          }
          break;
        }
        case "nav": {
          if (msg.action === "back" || msg.action === "forward" || msg.action === "reload") {
            await this.navigateHistory(msg.action);
          }
          break;
        }
        case "newTab": {
          await this.openNewTab();
          break;
        }
        case "activateTab": {
          if (typeof msg.targetId === "string") {
            await this.activateTab(msg.targetId);
          }
          break;
        }
        case "setWindowMode": {
          await this.setWindowMode(Boolean(msg.windowed));
          break;
        }
        case "mouse": {
          const x = Math.max(0, Math.min(this.lastFrameWidth - 1, Math.round(Number(msg.x) || 0)));
          const y = Math.max(0, Math.min(this.lastFrameHeight - 1, Math.round(Number(msg.y) || 0)));
          this.lastCursor = { x, y };
          const button =
            msg.button === "right" ? "right" : msg.button === "middle" ? "middle" : "left";
          const clickCount = Math.max(1, Math.min(3, Math.round(Number(msg.clickCount) || 1)));
          const cdp = await this.ensureCdpPage();
          if (msg.action === "move") {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x,
              y,
              button: "none",
            });
          } else if (msg.action === "down") {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x,
              y,
              button,
              clickCount,
            });
          } else if (msg.action === "up") {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x,
              y,
              button,
              clickCount,
            });
            setTimeout(() => {
              void this.refreshTargetsAndFrame();
            }, 120).unref();
          }
          break;
        }
        case "wheel": {
          const x = Math.max(0, Math.min(this.lastFrameWidth - 1, Math.round(Number(msg.x) || 0)));
          const y = Math.max(0, Math.min(this.lastFrameHeight - 1, Math.round(Number(msg.y) || 0)));
          const deltaX = Math.round(Number(msg.deltaX) || 0);
          const deltaY = Math.round(Number(msg.deltaY) || 0);
          const cdp = await this.ensureCdpPage();
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x,
            y,
            deltaX,
            deltaY,
          });
          break;
        }
        case "text":
        case "paste": {
          if (typeof msg.text === "string" && msg.text.length > 0) {
            const cdp = await this.ensureCdpPage();
            await cdp.send("Input.insertText", { text: msg.text.slice(0, 8192) });
          }
          break;
        }
        case "key": {
          if (typeof msg.key === "string") {
            await this.dispatchKey(
              msg.key,
              typeof msg.code === "string" ? msg.code : undefined,
              Array.isArray(msg.modifiers) ? msg.modifiers : undefined,
            );
          }
          break;
        }
      }
    } catch {
      /* ignore transient input error */
    }
  }

  async connectScreen(request: ScreenRequest): Promise<ScreenSession> {
    if (request.interactive && !request.controlToken) {
      throw new Error("interactive screen requires a control token");
    }
    const port = await this.ensureServer();
    if (request.interactive && request.controlToken) {
      this.interactiveAllowed = true;
      this.controlToken = request.controlToken;
    }
    const mode = request.interactive ? "control" : "view";
    const socketToken = request.interactive ? this.controlToken! : this.viewToken;
    const wsPath = `/websockify?mode=${mode}&token=${encodeURIComponent(socketToken)}`;
    return {
      url: `http://127.0.0.1:${port}/embed.html?mode=${mode}&token=${encodeURIComponent(socketToken)}&path=${encodeURIComponent(wsPath)}`,
      singleUseSignIn: { screen: this.computerId },
      mimeType: "text/html",
      close: async () => undefined,
    };
  }

  async setScreenControl(interactive: boolean, controlToken?: string): Promise<void> {
    if (interactive) {
      if (!controlToken) throw new Error("interactive screen requires a control token");
      const previousToken = this.controlToken;
      this.interactiveAllowed = true;
      this.controlToken = controlToken;
      if (previousToken && previousToken !== controlToken) {
        for (const client of [...this.clients]) {
          if (client.mode === "control" && client.token !== controlToken) {
            client.ws.close(1000, "control_replaced");
            this.clients.delete(client);
          }
        }
      }
      return;
    }

    // If a controlToken is specified on revoke, only revoke if it matches the active lease token.
    if (controlToken && this.controlToken && controlToken !== this.controlToken) {
      return;
    }
    this.interactiveAllowed = false;
    this.controlToken = null;
    for (const client of [...this.clients]) {
      if (client.mode === "control") {
        client.ws.close(1000, "control_released");
        this.clients.delete(client);
      }
    }
    if (this.windowed) {
      await bestEffort(
        "return desktop browser to headless mode on control release",
        this.setWindowMode(false),
      );
    }
  }

  async releaseScreen(options?: { keepWarm?: boolean }): Promise<void> {
    await this.setScreenControl(false);
    if (!options?.keepWarm) {
      await this.stopBrowserProcess();
    }
  }

  async setWindowMode(windowed: boolean): Promise<void> {
    if (this.windowed === windowed && this.chromeProcess && !this.chromeProcess.killed) {
      this.broadcastState();
      return;
    }
    const targetUrl = this.currentUrl || "about:blank";
    this.windowed = windowed;
    await this.stopBrowserProcess();
    await this.ensureBrowserLaunched(true, targetUrl);
    this.broadcastState();
    await bestEffort(
      "capture desktop browser frame after window mode change",
      this.captureAndBroadcastFrame(),
    );
  }

  private async ensureBrowserLaunched(forceRetry = false, initialUrl?: string): Promise<void> {
    if (this.chromeProcess && !this.chromeProcess.killed && this.cdpPort > 0 && !forceRetry) {
      return;
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }
    this.launchPromise = this.launchBrowserInternal(initialUrl).finally(() => {
      this.launchPromise = null;
    });
    return this.launchPromise;
  }

  private async launchBrowserInternal(initialUrl?: string): Promise<void> {
    const executable = detectNativeBrowserExecutable(this.executableOverride);
    if (!executable) {
      this.browserAvailable = false;
      this.browserError = undefined;
      return;
    }

    await this.stopBrowserProcess();
    const startUrl =
      initialUrl && initialUrl !== "about:blank"
        ? initialUrl
        : this.currentUrl && this.currentUrl !== "about:blank"
          ? this.currentUrl
          : "about:blank";

    const { proc, port } = await launchChromiumProcess({
      executable,
      profileDir: this.profileDir,
      workspaceHome: this.workspaceHome,
      windowed: this.windowed,
      startUrl,
      onSpawned: (spawned) => {
        this.chromeProcess = spawned;
      },
      onStartupFailed: () => this.stopBrowserProcess(),
    });

    this.cdpPort = port;
    this.browserAvailable = true;
    this.browserError = undefined;
    this.launchStartedAt = Date.now();

    proc.once("exit", () => {
      if (this.chromeProcess === proc) {
        this.chromeProcess = null;
        this.cdpPort = 0;
        this.cdpConnection?.close();
        this.cdpConnection = null;
        if (!this.stoppingProcess) {
          const wasWindowed = this.windowed;
          if (wasWindowed) {
            this.windowed = false;
            this.consecutiveCrashCount = 0;
            this.broadcastState();
          } else {
            const uptime = Date.now() - this.launchStartedAt;
            this.consecutiveCrashCount = uptime > 5_000 ? 0 : this.consecutiveCrashCount + 1;
          }
          if (this.clients.size > 0) {
            if (!wasWindowed && this.consecutiveCrashCount > 2) {
              this.browserAvailable = false;
              this.browserError = "Browser exited unexpectedly.";
              this.broadcastState();
            } else {
              const reason = wasWindowed
                ? "relaunch headless desktop browser after external window closed"
                : "relaunch headless desktop browser after unexpected exit";
              void bestEffort(
                reason,
                this.ensureBrowserLaunched(true, this.currentUrl)
                  .catch((error) => {
                    this.browserAvailable = false;
                    this.browserError = error instanceof Error ? error.message : String(error);
                  })
                  .then(() => {
                    this.broadcastState();
                    if (this.browserAvailable) return this.captureAndBroadcastFrame();
                    return null;
                  }),
              );
            }
          }
        }
      }
    });

    await this.ensureCdpPage();
    this.startTargetPoll();
  }

  private startTargetPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (!this.chromeProcess || this.clients.size === 0) return;
      void this.refreshTargetsAndFrame();
    }, 1500);
    this.pollTimer.unref();
  }

  private async refreshTargetsAndFrame(): Promise<void> {
    if (!this.cdpPort) return;
    await bestEffort("sync desktop browser targets", this.syncTargets());
    if (this.windowed && this.clients.size > 0) {
      await bestEffort(
        "capture desktop browser frame while windowed",
        this.captureAndBroadcastFrame(),
      );
    }
  }

  private async fetchJson<T>(pathname: string, method = "GET"): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${this.cdpPort}${pathname}`, {
      method,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      throw new Error(`CDP HTTP ${pathname} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async syncTargets(): Promise<CdpTargetInfo[]> {
    const list = await this.fetchJson<CdpTargetInfo[]>("/json/list");
    const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (pages.length === 0) {
      const created = await this.fetchJson<CdpTargetInfo>("/json/new?about:blank", "PUT").catch(
        () => this.fetchJson<CdpTargetInfo>("/json/new?about:blank", "GET"),
      );
      if (created?.webSocketDebuggerUrl) {
        pages.push(created);
      }
    }
    if (!this.activeTargetId || !pages.some((p) => p.id === this.activeTargetId)) {
      this.activeTargetId = pages[0]?.id ?? null;
    }
    const active = pages.find((p) => p.id === this.activeTargetId) ?? pages[0];
    if (active) {
      if (active.url) this.currentUrl = active.url;
      if (active.title) this.currentTitle = active.title;
    }
    this.tabs = pages.map((p) => ({
      id: p.id,
      title: p.title || p.url || "New Tab",
      url: p.url || "about:blank",
      active: p.id === this.activeTargetId,
    }));
    this.broadcastState();
    return pages;
  }

  private async ensureCdpPage(): Promise<CdpPageConnection> {
    await this.ensureBrowserLaunched();
    if (!this.browserAvailable || !this.cdpPort) {
      throw new Error("Native Chrome or Edge browser is not installed on this computer.");
    }
    const pages = await this.syncTargets();
    const target = pages.find((p) => p.id === this.activeTargetId) ?? pages[0];
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("No active browser tab available");
    }
    if (this.cdpConnection?.open && this.cdpConnection.targetId === target.id) {
      return this.cdpConnection;
    }
    this.cdpConnection?.close();
    const ws = await connectLocalWebSocket(target.webSocketDebuggerUrl, {
      signal: AbortSignal.timeout(8_000),
    });
    const conn = new CdpPageConnection(target.id, ws);
    this.cdpConnection = conn;

    conn.on("Page.screencastFrame", (params) => {
      const data = typeof params.data === "string" ? params.data : "";
      const sessionId = params.sessionId;
      if (typeof sessionId === "number") {
        void bestEffort("ack screencast", conn.send("Page.screencastFrameAck", { sessionId }));
      }
      if (data) {
        const meta =
          typeof params.metadata === "object" && params.metadata !== null ? params.metadata : null;
        const devW = meta && "deviceWidth" in meta ? meta.deviceWidth : undefined;
        const devH = meta && "deviceHeight" in meta ? meta.deviceHeight : undefined;
        if (typeof devW === "number" && devW > 0) {
          this.lastFrameWidth = Math.round(devW);
        }
        if (typeof devH === "number" && devH > 0) {
          this.lastFrameHeight = Math.round(devH);
        }
        this.lastFrameBase64 = data;
        this.lastFrameBytes = Uint8Array.from(Buffer.from(data, "base64"));
        this.broadcastFrame(data);
      }
    });

    conn.on("Page.frameNavigated", (params) => {
      const frame = params.frame as { parentId?: string; url?: string } | undefined;
      if (!frame?.parentId && typeof frame?.url === "string") {
        this.currentUrl = frame.url;
        this.broadcastState();
      }
    });

    conn.on("Page.javascriptDialogOpening", (params) => {
      const message = String(params.message ?? "");
      const dialogType = String(params.type ?? "alert");
      if (dialogType === "alert" || dialogType === "beforeunload") {
        this.pendingNotes.push(`Closed ${dialogType} dialog: ${message}`.trim());
      } else {
        this.openDialogMessage = `${dialogType}: ${message}`;
      }
      void bestEffort(
        "accept CDP dialog",
        conn.send("Page.handleJavaScriptDialog", { accept: true }),
      );
    });

    conn.on("Browser.downloadWillBegin", (params) => {
      const filename = String(params.suggestedFilename || "download");
      if (this.activeDownloadsDir) {
        this.completedDownloads.push({
          name: filename,
          path: `${this.activeDownloadsDir}/${filename}`,
          type: "application/octet-stream",
          size: 0,
        });
      }
    });

    await bestEffort("enable CDP Page domain", conn.send("Page.enable"));
    await bestEffort("enable CDP Runtime domain", conn.send("Runtime.enable"));
    await bestEffort("enable CDP DOM domain", conn.send("DOM.enable"));
    if (!this.windowed) {
      this.lastFrameWidth = DEFAULT_WIDTH;
      this.lastFrameHeight = DEFAULT_HEIGHT;
      const metrics = {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      };
      await bestEffort("set CDP metrics", conn.send("Emulation.setDeviceMetricsOverride", metrics));
    }
    const screencastOpts = {
      format: "jpeg",
      quality: 80,
      maxWidth: DEFAULT_WIDTH,
      maxHeight: DEFAULT_HEIGHT,
      everyNthFrame: 1,
    };
    await bestEffort("start CDP screencast", conn.send("Page.startScreencast", screencastOpts));
    await bestEffort("capture initial CDP page screenshot", this.captureAndBroadcastFrame());
    return conn;
  }

  private async configureDownloads(
    cdp: CdpPageConnection,
    downloadsSubdir?: string,
  ): Promise<void> {
    if (!downloadsSubdir) return;
    const cleaned = downloadsSubdir.replace(/^\/+|\/+$/g, "");
    if (!cleaned || cleaned.includes("..")) return;
    const fullDir = path.resolve(this.workspaceHome, cleaned);
    if (!isAllowedDesktopPath(fullDir, [this.workspaceHome])) return;
    await mkdir(fullDir, { recursive: true });
    this.activeDownloadsDir = cleaned;
    await bestEffort(
      "configure CDP download directory",
      cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: fullDir,
        eventsEnabled: true,
      }),
    );
  }

  async captureAndBroadcastFrame(): Promise<Uint8Array | null> {
    const cdp = await this.ensureCdpPage();
    if (this.windowed) {
      const vp = await readWindowedLayoutViewport(cdp);
      if (vp?.width) this.lastFrameWidth = vp.width;
      if (vp?.height) this.lastFrameHeight = vp.height;
    }
    const shot = await bestEffort(
      "capture CDP page screenshot",
      cdp.send<{ data?: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality: 82,
      }),
    );
    if (shot?.data) {
      this.lastFrameBase64 = shot.data;
      this.lastFrameBytes = Uint8Array.from(Buffer.from(shot.data, "base64"));
      this.broadcastFrame(shot.data);
      return this.lastFrameBytes;
    }
    return this.lastFrameBytes;
  }

  async navigate(rawUrl: string, downloadsSubdir?: string): Promise<void> {
    const url = normalizeNavigationUrl(rawUrl);
    const cdp = await this.ensureCdpPage();
    await this.configureDownloads(cdp, downloadsSubdir);
    await cdp.send("Page.navigate", { url });
    await this.waitForPageSettle(cdp, 3_500);
    await bestEffort("sync CDP targets after navigate", this.syncTargets());
    await bestEffort("capture CDP frame after navigate", this.captureAndBroadcastFrame());
  }

  async navigateHistory(action: "back" | "forward" | "reload"): Promise<void> {
    const cdp = await this.ensureCdpPage();
    if (action === "reload") {
      await cdp.send("Page.reload", {});
    } else {
      const history = await cdp.send<{
        currentIndex: number;
        entries: Array<{ id: number; url: string }>;
      }>("Page.getNavigationHistory");
      const delta = action === "back" ? -1 : 1;
      const targetEntry = history.entries?.[history.currentIndex + delta];
      if (targetEntry) {
        await cdp.send("Page.navigateToHistoryEntry", { entryId: targetEntry.id });
      }
    }
    await this.waitForPageSettle(cdp, 2_000);
    await bestEffort("sync CDP targets after history navigation", this.syncTargets());
    await bestEffort("capture CDP frame after history navigation", this.captureAndBroadcastFrame());
  }

  async openNewTab(url = "about:blank"): Promise<void> {
    await this.ensureBrowserLaunched();
    const norm = normalizeNavigationUrl(url);
    const encoded = encodeURIComponent(norm);
    const created = await this.fetchJson<CdpTargetInfo>(`/json/new?${encoded}`, "PUT").catch(() =>
      this.fetchJson<CdpTargetInfo>(`/json/new?${encoded}`, "GET"),
    );
    if (created?.id) {
      this.activeTargetId = created.id;
      await this.ensureCdpPage();
    }
  }

  async activateTab(targetId: string): Promise<void> {
    await this.ensureBrowserLaunched();
    this.activeTargetId = targetId;
    await bestEffort(
      "activate CDP target tab",
      this.fetchJson(`/json/activate/${encodeURIComponent(targetId)}`),
    );
    await this.ensureCdpPage();
  }

  private async waitForPageSettle(cdp: CdpPageConnection, maxWaitMs = 2_500): Promise<void> {
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

  async dispatchKey(
    rawKey: string,
    rawCode?: string,
    modifiers?: readonly string[],
  ): Promise<void> {
    const cdp = await this.ensureCdpPage();
    await dispatchCdpKey(cdp, rawKey, rawCode, modifiers);
  }

  async applyComputerAction(action: ComputerAction): Promise<void> {
    const cdp = await this.ensureCdpPage();
    await executeCdpComputerAction(
      cdp,
      action,
      { width: this.lastFrameWidth, height: this.lastFrameHeight },
      {
        onCursor: (pt) => {
          this.lastCursor = pt;
        },
        onNavigate: (url) => this.navigate(url),
      },
    );
  }

  private async evaluateSnapshot(
    cdp: CdpPageConnection,
    query?: string,
  ): Promise<EvaluatedDomSnapshot> {
    const snap = await evaluateCdpDomSnapshot(cdp, this.currentUrl, this.currentTitle, query);
    this.currentUrl = snap.url || this.currentUrl;
    this.currentTitle = snap.title || this.currentTitle;
    return snap;
  }

  private drainPageMeta() {
    const note = this.pendingNotes.length > 0 ? this.pendingNotes.splice(0).join("; ") : undefined;
    const dialog = this.openDialogMessage;
    this.openDialogMessage = undefined;
    const downloads =
      this.completedDownloads.length > 0 ? this.completedDownloads.splice(0) : undefined;
    return {
      ...(note ? { note } : {}),
      ...(dialog ? { dialog } : {}),
      ...(downloads ? { downloads } : {}),
    };
  }

  async pageBrowser(
    request: PageBrowserCommand,
    _context: AdapterContext,
  ): Promise<PageBrowserResult> {
    return runDesktopPageBrowser(request, {
      ensureCdpPage: () => this.ensureCdpPage(),
      navigate: (url, downloads) => this.navigate(url, downloads),
      configureDownloads: (cdp, downloads) => this.configureDownloads(cdp, downloads),
      evaluateSnapshot: (cdp, query) => this.evaluateSnapshot(cdp, query),
      captureFrame: () =>
        bestEffort("capture CDP frame after pageBrowser", this.captureAndBroadcastFrame()),
      waitForSettle: (cdp, ms) => this.waitForPageSettle(cdp, ms),
      executeActStep: (cdp, step) => this.executeBrowserActStep(cdp, step),
      drainPageMeta: () => this.drainPageMeta(),
      fallbackState: () => ({ url: this.currentUrl, title: this.currentTitle }),
    });
  }

  private async executeBrowserActStep(
    cdp: CdpPageConnection,
    step: BrowserActStep,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return executeCdpBrowserActStep(cdp, step, this.workspaceHome, (x, y) =>
      this.applyComputerAction({
        kind: "pointer",
        type: "click",
        x,
        y,
        button: "left",
      }),
    );
  }

  async stopBrowserProcess(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.cdpConnection?.close();
    this.cdpConnection = null;
    this.cdpPort = 0;

    const proc = this.chromeProcess;
    this.chromeProcess = null;
    if (!proc) return;
    this.stoppingProcess = true;
    try {
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        await Promise.race([
          new Promise<void>((resolve) => proc.once("exit", () => resolve())),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              try {
                proc.kill("SIGKILL");
              } catch {
                /* ignore */
              }
              resolve();
            }, 1_500),
          ),
        ]);
      }
    } finally {
      this.stoppingProcess = false;
    }
  }

  async destroy(deleteProfile = false): Promise<void> {
    await this.setScreenControl(false);
    for (const client of [...this.clients]) {
      client.ws.close(1000, "computer_stopped");
    }
    this.clients.clear();
    await this.stopBrowserProcess();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      this.serverPort = 0;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    if (deleteProfile) {
      await bestEffort(
        "remove desktop browser profile directory",
        rm(this.profileDir, { recursive: true, force: true }),
      );
    }
  }
}
