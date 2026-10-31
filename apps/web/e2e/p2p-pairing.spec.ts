import path from "node:path";
import type { Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { startFakeAuthServer } from "../../../packages/p2p-prototype/src/fake-auth-server";
import { startGateway } from "../../../packages/p2p-prototype/src/gateway";
import { completePairing } from "../../../packages/p2p-prototype/src/gateway-client";
import { startNodeAgent } from "../../../packages/p2p-prototype/src/node-agent";
import {
  channelHttpHandler,
  demoHandler,
} from "../../../packages/p2p-prototype/src/node-channel-server";
import { generateKeyPair } from "../../../packages/p2p-prototype/src/pairing";
import { waitFor } from "../../../packages/p2p-prototype/src/test-util";
import { captureScreenshot } from "./helpers";
import { fetchLoopback, isLocalUrl, startConfiguredWeb } from "./p2p-network";

// Optional system Chromium for offline workstations; CI uses Playwright's installed browser.
test.use({
  video: "off",
  permissions: ["local-network-access"],
  launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
});

test("Vietnamese pairing at 360px connects to a local prototype node and carries RPC over RTC", async ({
  page,
}, testInfo) => {
  expect(["127.0.0.1", "localhost"]).toContain(
    new URL(testInfo.project.use.baseURL ?? "").hostname,
  );
  const web = await startConfiguredWeb(
    path.resolve(testInfo.project.testDir, ".."),
    "http://127.0.0.1:8787",
  );
  const auth = await startFakeAuthServer();
  const gateway = await startGateway({ port: 0, userVerifier: auth.verifier });
  let agent: ReturnType<typeof startNodeAgent> | undefined;
  const calls: string[] = [];
  const hostedRpc: string[] = [];
  await page.setViewportSize({ width: 360, height: 780 });
  // Real Chromium RTC, with host candidates only: this test never contacts a public STUN server.
  await page.addInitScript((gatewayUrl) => {
    localStorage.setItem("rakazo.uiLocale", "vi");
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(raw: string | URL, protocols?: string | string[]) {
        const url = new URL(raw);
        if (url.origin === "ws://127.0.0.1:8787") {
          const local = new URL(gatewayUrl);
          url.protocol = "ws:";
          url.host = local.host;
        }
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
          throw new Error("Only loopback WebSockets are allowed in this test");
        super(url, protocols);
      }
    };
    const NativeRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativeRTC {
      constructor(config?: RTCConfiguration) {
        super({ ...config, iceServers: [] });
      }
    };
  }, gateway.url);
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!isLocalUrl(url.href)) {
      await route.abort();
      return;
    }
    if (req.isNavigationRequest()) {
      const response = await fetchLoopback(route);
      if (!response) return;
      const headers = response.headers();
      if (headers["content-security-policy"]) {
        headers["content-security-policy"] = headers["content-security-policy"].replace(
          /connect-src [^;]+/,
          (directive) => `${directive} ${gateway.url} ${gateway.url.replace("http:", "ws:")}`,
        );
      }
      await route.fulfill({ response, headers });
    } else if (url.pathname === "/api/monitoring/config") {
      await route.fulfill({ json: { dsn: null } });
    } else if (url.pathname === "/api/auth/get-session") {
      await route.fulfill({
        json: {
          user: { id: "user", email: "user@example.test", name: "Test" },
          session: {
            id: "fake-session",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      });
    } else if (url.pathname === "/api/auth/p2p-token") {
      await route.fulfill({ json: { token: "token", expiresAt: Date.now() + 120_000 } });
    } else if (url.origin === "http://127.0.0.1:8787") {
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "authorization,content-type",
      };
      if (req.method() === "OPTIONS") await route.fulfill({ status: 204, headers: cors });
      else if (url.pathname === "/nodes")
        await route.fulfill({
          headers: cors,
          json: {
            nodes: gateway.connectedNodes().map((nodeId) => ({
              nodeId,
              name: "Máy tính thử",
              kind: "linux",
              pairedAt: Date.now(),
              lastSeenAt: null,
              online: true,
            })),
          },
        });
      else {
        const response = await fetchLoopback(route, `${gateway.url}${url.pathname}${url.search}`);
        if (!response) return;
        await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      }
    } else if (url.pathname.startsWith("/rpc/")) {
      if (url.pathname !== "/rpc/analytics/screen") hostedRpc.push(url.pathname);
      await route.fulfill({ status: 503, json: { error: "No hosted RPC" } });
    } else {
      const response = await fetchLoopback(route);
      if (response) await route.fulfill({ response });
    }
  });
  try {
    await page.goto(`${web.url}/app/pairing`);
    await expect(
      page.getByRole("heading", { name: "Ghép nối máy tính", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lấy mã ghép nối", exact: true }).click();
    const output = page.getByLabel("Mã ghép nối", { exact: true });
    await expect(output).toHaveText(/^[A-Z2-9]{8}$/);
    await captureScreenshot(page, testInfo, "pairing-code-vi-360");
    const key = generateKeyPair();
    await completePairing(gateway.url, await output.innerText(), "local-desktop", key);
    const demo = demoHandler();
    const handler = {
      async call(...args: Parameters<typeof demo.call>) {
        calls.push(args[0]);
        if (args[0] === "bots/list")
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode('{"json":[]}'),
          };
        return demo.call(...args);
      },
      subscribe: demo.subscribe,
    };
    agent = startNodeAgent({
      gatewayUrl: gateway.url,
      nodeId: "local-desktop",
      keyPair: key,
      handler: channelHttpHandler(handler),
      channel: { gatewayPublicKey: gateway.publicKey, allowedUsers: ["user"], handler },
    });
    await waitFor(() => agent?.connected() === true);
    await page.getByRole("button", { name: "Tải lại", exact: true }).click();
    await expect(page.getByText("Máy tính thử", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Kết nối", exact: true }).click();
    await expect(page.getByRole("status").getByText("Đã kết nối", { exact: true })).toBeVisible();
    // Exercise the application's oRPC fetch bridge, not a separate test transport.
    const bots = await page.evaluate(async () => {
      // Vite serves this source entry during the existing Playwright dev harness.
      const entry = "/src/lib/rpc.ts";
      const { rpc } = await import(/* @vite-ignore */ entry);
      return rpc.bots.list();
    });
    expect(bots).toEqual([]);
    expect(calls).toContain("bots/list");
    expect(hostedRpc).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await captureScreenshot(page, testInfo, "pairing-connected-vi-360");
    await agent.close();
    agent = undefined;
    await expect(page.getByRole("status")).toContainText("Không kết nối được");
    await captureScreenshot(page, testInfo, "pairing-disconnected-vi-360");
  } finally {
    await page.close();
    await agent?.close();
    await gateway.close();
    await auth.close();
    web.close();
  }
});

test("a build with no gateway shows the configuration error and sends no token", async ({
  page,
}, testInfo) => {
  const appOrigin = new URL(testInfo.project.use.baseURL ?? "").origin;
  expect(isLocalUrl(appOrigin)).toBe(true);
  const requests: { url: string; authorization?: string }[] = [];
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.setViewportSize({ width: 360, height: 780 });
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "vi"));
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    requests.push({ url: req.url(), authorization: req.headers().authorization });
    if (url.origin !== appOrigin) await route.abort();
    else if (url.pathname === "/api/monitoring/config")
      await route.fulfill({ json: { dsn: null } });
    else if (url.pathname === "/api/auth/get-session")
      await route.fulfill({
        json: {
          user: { id: "user", email: "user@example.test", name: "Test" },
          session: {
            id: "fake-session",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      });
    else if (url.pathname === "/api/auth/p2p-token" || url.pathname.startsWith("/rpc/"))
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    else {
      const response = await fetchLoopback(route);
      if (response) await route.fulfill({ response });
    }
  });
  await page.goto("/app/pairing");
  await expect(page.getByRole("alert")).toHaveText("Chưa cấu hình cổng P2P cho bản web này.");
  await expect(page.getByRole("heading", { name: "Ghép nối máy tính", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lấy mã ghép nối", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "pairing-unconfigured-vi-360");
  await page.waitForTimeout(1_000);
  expect(requests.filter(({ url }) => url.includes("p2p-token"))).toEqual([]);
  expect(requests.filter(({ url }) => new URL(url).origin !== appOrigin)).toEqual([]);
  expect(requests.filter(({ authorization }) => authorization)).toEqual([]);
  // The dev server's own hot-reload socket is the only one allowed.
  expect(sockets.filter((url) => new URL(url).host !== new URL(appOrigin).host)).toEqual([]);
});

test("HTTP guard aborts external hosts before fetching", async () => {
  let fetched = false;
  let aborted = false;
  const route = {
    request: () => ({ url: () => "https://blocked.example.test/" }),
    fetch: async () => {
      fetched = true;
      throw new Error("External fetch must not run");
    },
    abort: async () => {
      aborted = true;
    },
  } as unknown as Route;
  expect(await fetchLoopback(route)).toBeUndefined();
  expect(fetched).toBe(false);
  expect(aborted).toBe(true);
});

for (const location of [
  "https://blocked.example.test/",
  "//blocked.example.test/",
  "http://127.0.0.1:8787/local",
]) {
  test(`HTTP guard checks redirect destination ${location}`, async () => {
    let aborted = false;
    let options: unknown;
    const response = { headers: () => ({ location }), status: () => 302 };
    const route = {
      request: () => ({ url: () => "http://127.0.0.1:8787/start" }),
      fetch: async (value: unknown) => {
        options = value;
        return response;
      },
      abort: async () => {
        aborted = true;
      },
    } as unknown as Route;
    const result = await fetchLoopback(route);
    expect(options).toEqual({ url: "http://127.0.0.1:8787/start", maxRedirects: 0 });
    expect(aborted).toBe(!isLocalUrl(location.startsWith("//") ? `http:${location}` : location));
    expect(result).toBe(aborted ? undefined : response);
  });
}
