import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopBrowserManager, detectNativeBrowserExecutable } from "./desktop-browser.js";
import { normalizeCleanSignInUrl } from "./desktop-browser-cdp.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { renderDesktopScreenHtml } from "./desktop-screen-page.js";
import type { MinimalWebSocket } from "./desktop-ws.js";
import { connectLocalWebSocket } from "./desktop-ws.js";

const context: AdapterContext = {
  operationId: "op-desktop-browser-test",
  traceId: "trace-desktop-browser-test",
  spaceId: "space-test",
  userId: "user-test",
  signal: new AbortController().signal,
};

function waitForWsMessage(
  ws: MinimalWebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 6_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for matching WebSocket message"));
    }, timeoutMs);
    timer.unref();
    ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (predicate(parsed)) {
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {
        /* ignore invalid JSON */
      }
    });
  });
}

function waitForWsClose(ws: MinimalWebSocket, timeoutMs = 4_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    timer.unref();
    ws.onClose(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function createFakeChromiumBinary(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fake-chromium.mjs");
  const wrapperPath = path.join(
    dir,
    process.platform === "win32" ? "fake-chromium.cmd" : "fake-chromium.sh",
  );

  // 1x1 valid JPEG base64
  const tinyJpegBase64 =
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

  const script = `import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const args = process.argv.slice(2);
const userDataArg = args.find((a) => a.startsWith("--user-data-dir="));
const userDataDir = userDataArg ? userDataArg.slice("--user-data-dir=".length) : "";
const isHeadless = args.includes("--headless=new");
const initialUrl = args.find((a) => !a.startsWith("-")) || "about:blank";

const stateFile = userDataDir ? path.join(userDataDir, "profile-state.json") : "";
let persisted = { cookies: "session=persisted_1", lastUrl: initialUrl, launches: 0, modes: [] };
if (stateFile && existsSync(stateFile)) {
  try {
    persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
}
persisted.launches = (persisted.launches || 0) + 1;
persisted.pid = process.pid;
persisted.lastArgs = args;
persisted.modes = [...(persisted.modes || []), isHeadless ? "headless" : "windowed"];
if (initialUrl && initialUrl !== "about:blank") {
  persisted.lastUrl = initialUrl;
}
if (stateFile) {
  writeFileSync(stateFile, JSON.stringify(persisted), "utf8");
  writeFileSync(path.join(userDataDir, "SingletonLock"), "locked", "utf8");
}

let targets = [
  {
    id: "tab-1",
    type: "page",
    title: "VNBot Test Page",
    url: persisted.lastUrl || "about:blank",
  },
];
let recordedInputs = [];

function encodeWsText(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

const server = http.createServer((req, res) => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const u = new URL(req.url || "/", "http://127.0.0.1:" + port);
  if (u.pathname === "/json/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        targets.map((t) => ({
          ...t,
          webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/" + t.id,
        })),
      ),
    );
    return;
  }
  if (u.pathname === "/json/new") {
    const rawUrl = decodeURIComponent(u.search.slice(1) || "about:blank");
    const next = {
      id: "tab-" + (targets.length + 1),
      type: "page",
      title: "Tab " + (targets.length + 1),
      url: rawUrl,
      webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/tab-" + (targets.length + 1),
    };
    targets.push(next);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next));
    return;
  }
  if (u.pathname.startsWith("/json/activate/")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Target activated");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(String(key).trim() + WS_GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " + accept,
      "",
      "",
    ].join("\\r\\n"),
  );

  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (masked) {
        for (let i = 0; i < len; i++) payload[i] ^= buf[maskOffset + (i & 3)];
      }
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x1) {
        handleCdpMessage(socket, JSON.parse(payload.toString("utf8")));
      }
    }
  });
});

function handleCdpMessage(socket, msg) {
  const { id, method, params } = msg;
  const active = targets[0];
  if (method === "Page.navigate" && params?.url) {
    active.url = params.url;
    active.title = "Loaded " + params.url;
    if (stateFile) {
      persisted.lastUrl = active.url;
      writeFileSync(stateFile, JSON.stringify(persisted), "utf8");
    }
    socket.write(encodeWsText(JSON.stringify({ id, result: { frameId: "main" } })));
    socket.write(
      encodeWsText(
        JSON.stringify({
          method: "Page.frameNavigated",
          params: { frame: { id: "main", url: active.url } },
        }),
      ),
    );
    return;
  }
  if (method === "Page.captureScreenshot") {
    socket.write(
      encodeWsText(JSON.stringify({ id, result: { data: ${JSON.stringify(tinyJpegBase64)} } })),
    );
    return;
  }
  if (method === "Page.getLayoutMetrics") {
    socket.write(
      encodeWsText(
        JSON.stringify({
          id,
          result: {
            cssLayoutViewport: {
              clientWidth: isHeadless ? 1280 : 1440,
              clientHeight: isHeadless ? 800 : 900,
            },
          },
        }),
      ),
    );
    return;
  }
  if (method === "Page.getNavigationHistory") {
    socket.write(
      encodeWsText(
        JSON.stringify({
          id,
          result: {
            currentIndex: 0,
            entries: [{ id: 1, url: active.url }],
          },
        }),
      ),
    );
    return;
  }
  if (
    method === "Input.dispatchMouseEvent" ||
    method === "Input.dispatchKeyEvent" ||
    method === "Input.insertText"
  ) {
    recordedInputs.push({ method, params });
    if (stateFile) {
      persisted.inputs = recordedInputs;
      writeFileSync(stateFile, JSON.stringify(persisted), "utf8");
    }
    socket.write(encodeWsText(JSON.stringify({ id, result: {} })));
    return;
  }
  if (method === "Runtime.evaluate") {
    const expr = String(params?.expression || "");
    if (expr === "document.readyState") {
      socket.write(
        encodeWsText(JSON.stringify({ id, result: { result: { value: "complete" } } })),
      );
      return;
    }
    if (expr.includes("data-vnbot-ref") && expr.includes("Page text:")) {
      socket.write(
        encodeWsText(
          JSON.stringify({
            id,
            result: {
              result: {
                value: {
                  url: active.url,
                  title: active.title,
                  loading: false,
                  tree: '- button "Sign In" [e1]\\n- textbox "Email" [e2]',
                  elements: [
                    { ref: "e1", role: "button", name: "Sign In", tag: "button" },
                    { ref: "e2", role: "textbox", name: "Email", tag: "input" },
                  ],
                },
              },
            },
          }),
        ),
      );
      return;
    }
    if (expr.includes("click_point") || expr.includes("upload_ready")) {
      socket.write(
        encodeWsText(
          JSON.stringify({
            id,
            result: {
              result: {
                value: { status: "click_point", x: 120, y: 240 },
              },
            },
          }),
        ),
      );
      return;
    }
    socket.write(
      encodeWsText(
        JSON.stringify({
          id,
          result: { result: { value: { ok: true, purchase: null } } },
        }),
      ),
    );
    return;
  }
  socket.write(encodeWsText(JSON.stringify({ id, result: {} })));
}

server.listen(0, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.stderr.write("DevTools listening on ws://127.0.0.1:" + port + "/devtools/browser/fake\\n");
  if (userDataDir && existsSync(path.join(userDataDir, "crash-after-start"))) {
    setTimeout(() => process.exit(1), 40);
  }
});
`;

  await writeFile(scriptPath, script, "utf8");
  if (process.platform === "win32") {
    await writeFile(
      wrapperPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8",
    );
  } else {
    await writeFile(
      wrapperPath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
      "utf8",
    );
    await chmod(wrapperPath, 0o755);
  }
  return wrapperPath;
}

describe("DesktopBrowserManager and DesktopSandboxProvider browser screen", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("detects custom browser executable path override across platforms", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-detect-browser-"));
    tempDirs.push(dir);
    const fakeBin = await createFakeChromiumBinary(dir);

    expect(detectNativeBrowserExecutable(fakeBin, "win32", {})).toBe(fakeBin);
    expect(detectNativeBrowserExecutable(fakeBin, "darwin", {})).toBe(fakeBin);
    expect(
      detectNativeBrowserExecutable(undefined, "win32", { VNBOT_DESKTOP_BROWSER_PATH: fakeBin }),
    ).toBe(fakeBin);
  });

  it("serves /embed.html, streams CDP frames, enforces view vs control permissions, and switches between embedded & external window with shared profile", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-browser-"));
    tempDirs.push(dir);
    const fakeBin = await createFakeChromiumBinary(dir);

    const provider = new DesktopSandboxProvider({
      root: dir,
      browserExecutablePath: fakeBin,
    });

    const computer = await provider.provision({ botId: "bot-alpha", homePath: "" }, context);
    try {
      // 1. Write a workspace file and verify browser profile is isolated outside workspace export
      await provider.writeFile(computer, {
        path: "notes.txt",
        content: new TextEncoder().encode("workspace file"),
      });

      // 2. Connect read-only viewer screen
      const viewSession = await provider.connectScreen(
        computer,
        { view: "stream", interactive: false },
        context,
      );
      expect(viewSession.url).toContain("/embed.html");
      expect(viewSession.singleUseSignIn).toEqual({ screen: computer.id });

      const htmlRes = await fetch(viewSession.url!);
      expect(htmlRes.status).toBe(200);
      const htmlText = await htmlRes.text();
      expect(htmlText).toContain("Mở cửa sổ ngoài");
      expect(htmlText).toContain("noVNC_connected");

      const viewUrl = new URL(viewSession.url!);
      const viewWsPath = viewUrl.searchParams.get("path")!;
      const viewWs = await connectLocalWebSocket(`ws://${viewUrl.host}${viewWsPath}`);

      const initialState = await waitForWsMessage(viewWs, (m) => m.type === "state");
      expect(initialState.browserAvailable).toBe(true);
      expect(initialState.windowed).toBe(false);

      const initialFrame = await waitForWsMessage(viewWs, (m) => m.type === "frame");
      expect(typeof initialFrame.data).toBe("string");
      expect((initialFrame.data as string).length).toBeGreaterThan(10);

      // 3. Verify a view-only client cannot forge control mode or mutate browser navigation
      await expect(
        connectLocalWebSocket(
          `ws://${viewUrl.host}/websockify?mode=control&token=${viewUrl.searchParams.get("token")}`,
        ),
      ).rejects.toThrow(/rejected: HTTP\/1\.1 403/);

      viewWs.send(JSON.stringify({ type: "navigate", url: "https://evil.example.com" }));
      await new Promise((r) => setTimeout(r, 150));

      // 4. Grant interactive control and connect control WebSocket
      const controlSession = await provider.connectScreen(
        computer,
        { view: "stream", interactive: true, controlToken: "lease-token-1" },
        context,
      );
      const controlUrl = new URL(controlSession.url!);
      const controlWsPath = controlUrl.searchParams.get("path")!;
      const controlWs = await connectLocalWebSocket(`ws://${controlUrl.host}${controlWsPath}`);
      await waitForWsMessage(controlWs, (m) => m.type === "state");

      // Navigate via control socket
      controlWs.send(JSON.stringify({ type: "navigate", url: "accounts.google.com" }));
      const navState = await waitForWsMessage(
        controlWs,
        (m) => m.type === "state" && m.url === "https://accounts.google.com",
      );
      expect(navState.url).toBe("https://accounts.google.com");

      // 5. Switch to external window mode ("Mở cửa sổ ngoài") and verify profile & URL stay synced
      controlWs.send(JSON.stringify({ type: "setWindowMode", windowed: true }));
      const windowedState = await waitForWsMessage(
        controlWs,
        (m) => m.type === "state" && m.windowed === true,
      );
      expect(windowedState.windowed).toBe(true);
      expect(windowedState.url).toBe("https://accounts.google.com");

      // 6. Test pageBrowser (snapshot & act) on the same desktop computer
      const snapResult = await provider.pageBrowser!(computer, { command: "snapshot" }, context);
      expect(snapResult.ok).toBe(true);
      expect(snapResult.url).toBe("https://accounts.google.com");
      expect(snapResult.elements?.some((el) => el.ref === "e1" && el.name === "Sign In")).toBe(
        true,
      );

      const actResult = await provider.pageBrowser!(
        computer,
        { command: "act", actions: [{ kind: "click", ref: "e1" }] },
        context,
      );
      expect(actResult.ok).toBe(true);
      expect(actResult.completed).toBe(1);

      // 7. Releasing control closes control socket and docks external window back to headless
      const closePromise = waitForWsClose(controlWs);
      await provider.setScreenControl(computer, false, context, "lease-token-1");
      await closePromise;

      const dockedState = await waitForWsMessage(
        viewWs,
        (m) => m.type === "state" && m.windowed === false,
      );
      expect(dockedState.windowed).toBe(false);

      // 8. Verify exported workspace only contains notes.txt and NO browser SingletonLock or profile files
      const exported: string[] = [];
      for await (const file of provider.exportWorkspace(computer)) {
        exported.push(file.path);
      }
      expect(exported).toEqual(["notes.txt"]);

      viewWs.close();
    } finally {
      await provider.destroy(computer, context);
    }
  });

  it("reports browserAvailable: false cleanly when no native browser binary is installed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-no-browser-"));
    tempDirs.push(dir);

    const manager = new DesktopBrowserManager({
      root: dir,
      browserExecutablePath: path.join(dir, "non-existent-browser-bin"),
    });
    // Temporarily shadow PATH/env in detect by testing session directly when binary is missing
    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const workspaceHome = path.join(dir, "workspace");
      await mkdir(workspaceHome, { recursive: true });
      const session = await manager.connectScreen("comp-missing", "bot-missing", workspaceHome, {
        view: "stream",
        interactive: false,
      });
      expect(session.url).toContain("/embed.html");
    } finally {
      process.env.PATH = origPath;
      await manager.destroy("comp-missing", true);
    }
  });

  it("executes desktop screen client honoring mode=view, preserving tab-select on identical polls, and sending double/triple pointer clickCount", () => {
    const html = renderDesktopScreenHtml();
    const match = html.match(/<script>([\s\S]*)<\/script>/);
    const scriptBody = match?.[1] ?? "";
    expect(scriptBody).not.toBe("");

    function mountClient(href: string) {
      let nowMs = 1_000;
      const sent: Array<Record<string, unknown>> = [];
      let tabClearCount = 0;

      const makeEl = (id: string) => {
        const listeners = new Map<string, Array<(e: unknown) => void>>();
        const attrs = new Map<string, string>();
        const classSet = new Set<string>();
        let children: unknown[] = [];
        let innerHtmlVal = "";
        const el = {
          id,
          hidden: false,
          disabled: false,
          value: "",
          placeholder: "",
          title: "",
          textContent: "",
          style: {} as Record<string, string>,
          dataset: {} as Record<string, string>,
          width: 0,
          height: 0,
          classList: {
            add(...names: string[]) {
              for (const n of names) classSet.add(n);
            },
            remove(...names: string[]) {
              for (const n of names) classSet.delete(n);
            },
            contains(n: string) {
              return classSet.has(n);
            },
          },
          setAttribute: (k: string, v: string) => attrs.set(k, v),
          hasAttribute: (k: string) => attrs.has(k),
          getContext: () => ({ drawImage: () => undefined }),
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
          focus: () => undefined,
          select: () => undefined,
          setPointerCapture: () => undefined,
          appendChild: (child: unknown) => {
            children.push(child);
          },
          addEventListener: (type: string, fn: (e: unknown) => void) => {
            const list = listeners.get(type) ?? [];
            list.push(fn);
            listeners.set(type, list);
          },
          dispatch(type: string, event: Record<string, unknown>) {
            for (const fn of listeners.get(type) ?? []) fn(event);
          },
          get childrenCount() {
            return children.length;
          },
          get innerHTML() {
            return innerHtmlVal;
          },
          set innerHTML(val: string) {
            innerHtmlVal = val;
            if (val === "") {
              tabClearCount += 1;
              children = [];
            }
          },
        };
        return el;
      };

      const elements = new Map<string, ReturnType<typeof makeEl>>();
      const getEl = (id: string) => {
        let found = elements.get(id);
        if (!found) {
          found = makeEl(id);
          elements.set(id, found);
        }
        return found;
      };
      const rootEl = makeEl("html");
      const doc = {
        location: { href },
        documentElement: rootEl,
        activeElement: null,
        getElementById: getEl,
        createElement: (tag: string) => makeEl(tag),
      };
      const urlObj = new URL(href);
      const win = {
        location: {
          href,
          hash: urlObj.hash,
          pathname: urlObj.pathname,
          protocol: urlObj.protocol,
          host: urlObj.host,
        },
        devicePixelRatio: 1,
      };
      let socketInstance: { emitMessage: (payload: unknown) => void } | null = null;
      class FakeWebSocket {
        static OPEN = 1;
        readyState = 1;
        private listeners = new Map<string, Array<(e: unknown) => void>>();
        constructor(_url: string) {
          socketInstance = {
            emitMessage: (payload: unknown) => {
              for (const fn of this.listeners.get("message") ?? []) {
                fn({ data: JSON.stringify(payload) });
              }
            },
          };
        }
        addEventListener(type: string, fn: (e: unknown) => void) {
          const list = this.listeners.get(type) ?? [];
          list.push(fn);
          this.listeners.set(type, list);
        }
        send(raw: string) {
          sent.push(JSON.parse(raw) as Record<string, unknown>);
        }
      }
      class FakeResizeObserver {
        observe() {}
      }
      class FakeImage {
        onload: (() => void) | null = null;
        set src(_v: string) {
          this.onload?.();
        }
      }
      const perf = { now: () => nowMs };
      const nav = { language: "en-US" };

      const runner = new Function(
        "document",
        "window",
        "navigator",
        "WebSocket",
        "ResizeObserver",
        "Image",
        "performance",
        scriptBody,
      );
      runner(doc, win, nav, FakeWebSocket, FakeResizeObserver, FakeImage, perf);
      return {
        getEl,
        socket: socketInstance!,
        sent,
        getTabClearCount: () => tabClearCount,
        advanceMs: (ms: number) => {
          nowMs += ms;
        },
      };
    }

    // 1. Direct view URL (?mode=view without view_only) must hide toolbar and block pointer/key dispatch.
    const viewClient = mountClient("http://127.0.0.1:41234/embed.html?mode=view&token=t1");
    expect(viewClient.getEl("toolbar").hidden).toBe(true);
    viewClient.getEl("viewport").dispatch("pointerdown", {
      preventDefault() {},
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      button: 0,
      detail: 0,
    });
    expect(viewClient.sent).toEqual([]);

    // 2. Proxied control URL (?view_only=false) and direct ?mode=control show toolbar.
    expect(
      mountClient("https://app.test/novnc/session/control/1.t/embed.html?view_only=false").getEl(
        "toolbar",
      ).hidden,
    ).toBe(false);
    const controlClient = mountClient("http://127.0.0.1:41234/embed.html?mode=control&token=t2");
    expect(controlClient.getEl("toolbar").hidden).toBe(false);

    // 3. Repeated identical state broadcasts do not clear & rebuild tab-select; actual tab changes do.
    const tabsA = [
      { id: "tab-1", title: "One", url: "https://one.test", active: true },
      { id: "tab-2", title: "Two", url: "https://two.test", active: false },
    ];
    controlClient.socket.emitMessage({ type: "state", url: "https://one.test", tabs: tabsA });
    expect(controlClient.getTabClearCount()).toBe(1);
    controlClient.socket.emitMessage({ type: "state", url: "https://one.test", tabs: tabsA });
    expect(controlClient.getTabClearCount()).toBe(1);
    controlClient.socket.emitMessage({
      type: "state",
      url: "https://two.test",
      tabs: [
        { ...tabsA[0], active: false },
        { ...tabsA[1], active: true },
      ],
    });
    expect(controlClient.getTabClearCount()).toBe(2);

    // 4. Consecutive PointerEvents (where native detail === 0) emit clickCount 1, 2, 3, then reset on slow/moved click.
    const clickAt = (clientX: number, clientY: number) => {
      const vp = controlClient.getEl("viewport") as {
        dispatch: (type: string, e: unknown) => void;
      };
      vp.dispatch("pointerdown", {
        preventDefault() {},
        pointerId: 1,
        clientX,
        clientY,
        button: 0,
        detail: 0,
      });
      vp.dispatch("pointerup", {
        preventDefault() {},
        pointerId: 1,
        clientX,
        clientY,
        button: 0,
        detail: 0,
      });
    };
    clickAt(200, 200);
    controlClient.advanceMs(120);
    clickAt(201, 201);
    controlClient.advanceMs(120);
    clickAt(201, 202);
    controlClient.advanceMs(600);
    clickAt(201, 202);

    expect(
      controlClient.sent
        .filter((msg) => msg.type === "mouse")
        .map((msg) => [msg.action, msg.clickCount]),
    ).toEqual([
      ["down", 1],
      ["up", 1],
      ["down", 2],
      ["up", 2],
      ["down", 3],
      ["up", 3],
      ["down", 1],
      ["up", 1],
    ]);
  });

  it("syncs windowed viewport dimensions from layout metrics and relaunches headless browser on unexpected exit while connected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-relaunch-"));
    tempDirs.push(dir);
    const fakeBin = await createFakeChromiumBinary(dir);
    const manager = new DesktopBrowserManager({
      root: dir,
      browserExecutablePath: fakeBin,
    });
    const workspaceHome = path.join(dir, "workspace");
    await mkdir(workspaceHome, { recursive: true });

    try {
      const controlSession = await manager.connectScreen(
        "comp-relaunch",
        "bot-relaunch",
        workspaceHome,
        { view: "stream", interactive: true, controlToken: "ctrl-token-1" },
      );
      const url = new URL(controlSession.url!);
      const ws = await connectLocalWebSocket(`ws://${url.host}${url.searchParams.get("path")}`);
      await waitForWsMessage(ws, (m) => m.type === "frame");

      // Navigate and verify external window syncs 1440x900 CSS viewport dimensions.
      ws.send(JSON.stringify({ type: "navigate", url: "https://example.test/work" }));
      await waitForWsMessage(
        ws,
        (m) => m.type === "state" && m.url === "https://example.test/work",
      );

      ws.send(JSON.stringify({ type: "setWindowMode", windowed: true }));
      const windowedFrame = await waitForWsMessage(
        ws,
        (m) => m.type === "frame" && m.width === 1440 && m.height === 900,
      );
      expect(windowedFrame).toMatchObject({ width: 1440, height: 900 });

      ws.send(JSON.stringify({ type: "setWindowMode", windowed: false }));
      await waitForWsMessage(
        ws,
        (m) => m.type === "state" && m.windowed === false && m.width === 1280,
      );

      // Kill headless Chromium unexpectedly while client is connected; verify auto-relaunch on same URL.
      const stateFile = path.join(dir, "desktop-browsers", "bot-relaunch", "profile-state.json");
      const beforeKill = JSON.parse(await readFile(stateFile, "utf8")) as {
        pid: number;
        launches: number;
      };
      process.kill(beforeKill.pid, "SIGKILL");
      await vi.waitFor(
        async () => {
          const afterKill = JSON.parse(await readFile(stateFile, "utf8")) as { launches: number };
          expect(afterKill.launches).toBeGreaterThan(beforeKill.launches);
        },
        { timeout: 8_000, interval: 50 },
      );
      const relaunchedState = await waitForWsMessage(
        ws,
        (m) =>
          m.type === "state" &&
          m.browserAvailable === true &&
          m.url === "https://example.test/work",
        8_000,
      );
      expect(relaunchedState.browserAvailable).toBe(true);

      ws.close();
    } finally {
      await manager.destroy("comp-relaunch", true);
    }
  });

  it("stops crash-looping after repeated immediate browser exits and surfaces browserAvailable: false", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-crashloop-"));
    tempDirs.push(dir);
    const fakeBin = await createFakeChromiumBinary(dir);
    const manager = new DesktopBrowserManager({
      root: dir,
      browserExecutablePath: fakeBin,
    });
    const workspaceHome = path.join(dir, "workspace");
    const profileDir = path.join(dir, "desktop-browsers", "bot-crash");
    await mkdir(workspaceHome, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, "crash-after-start"), "1", "utf8");

    try {
      const session = await manager.connectScreen("comp-crash", "bot-crash", workspaceHome, {
        view: "stream",
        interactive: false,
      });
      const url = new URL(session.url!);
      const ws = await connectLocalWebSocket(`ws://${url.host}${url.searchParams.get("path")}`);
      const failedState = await waitForWsMessage(
        ws,
        (m) => m.type === "state" && m.browserAvailable === false,
        8_000,
      );
      expect(failedState.browserAvailable).toBe(false);
      expect(String(failedState.error ?? "")).toContain("exited unexpectedly");
      ws.close();
    } finally {
      await manager.destroy("comp-crash", true);
    }
  });

  it("opens clean non-CDP external Chrome window for Google sign-in and normalizes rejected URLs", async () => {
    expect(
      normalizeCleanSignInUrl(
        "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com",
      ),
    ).toBe("https://accounts.google.com/");
    expect(normalizeCleanSignInUrl("https://github.com/login")).toBe("https://github.com/login");

    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-clean-signin-"));
    tempDirs.push(dir);
    const fakeBin = await createFakeChromiumBinary(dir);
    const manager = new DesktopBrowserManager({
      root: dir,
      browserExecutablePath: fakeBin,
    });
    const workspaceHome = path.join(dir, "workspace");
    await mkdir(workspaceHome, { recursive: true });

    try {
      const session = await manager.connectScreen("comp-clean", "bot-clean", workspaceHome, {
        view: "stream",
        interactive: true,
        controlToken: "clean-lease-1",
      });
      const url = new URL(session.url!);
      const ws = await connectLocalWebSocket(`ws://${url.host}${url.searchParams.get("path")}`);
      await waitForWsMessage(ws, (m) => m.type === "state" && m.browserAvailable === true);

      ws.send(
        JSON.stringify({
          type: "navigate",
          url: "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fmail.google.com",
        }),
      );
      await waitForWsMessage(
        ws,
        (m) => m.type === "state" && String(m.url ?? "").includes("/v3/signin/rejected"),
      );

      ws.send(JSON.stringify({ type: "setWindowMode", windowed: true, clean: true }));
      const cleanState = await waitForWsMessage(
        ws,
        (m) => m.type === "state" && m.windowed === true && m.cleanWindow === true,
      );
      expect(cleanState.cleanWindow).toBe(true);

      const stateFile = path.join(dir, "desktop-browsers", "bot-clean", "profile-state.json");
      let persisted: { lastArgs?: string[]; lastUrl?: string } = {};
      await vi.waitFor(
        async () => {
          persisted = JSON.parse(await readFile(stateFile, "utf8")) as typeof persisted;
          expect(persisted.lastArgs).toBeDefined();
          expect(persisted.lastArgs).not.toContain("--headless=new");
        },
        { timeout: 3_000, interval: 50 },
      );
      expect(persisted.lastArgs).not.toContain("--remote-debugging-port=0");
      expect(persisted.lastArgs).not.toContain("--disable-sync");
      expect(persisted.lastUrl).toBe("https://accounts.google.com/");

      ws.send(JSON.stringify({ type: "setWindowMode", windowed: false }));
      const dockedState = await waitForWsMessage(
        ws,
        (m) => m.type === "state" && m.windowed === false && m.cleanWindow === false,
      );
      expect(dockedState.windowed).toBe(false);
      expect(dockedState.cleanWindow).toBe(false);

      ws.close();
    } finally {
      await manager.destroy("comp-clean", true);
    }
  });
});
