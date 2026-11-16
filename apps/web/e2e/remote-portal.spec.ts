import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { rememberedComputerKey } from "../src/lib/remembered-computer";
import { portalFramePolicy } from "../src/remote-frame-policy";
import { captureScreenshot } from "./helpers";

test("the portal keeps a computer session isolated while its address stays on the portal", async ({
  page,
  context,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("The portal test needs the existing web server");
  await signInForPortal(page, `portal-frame-${Date.now()}@example.test`);
  const session = await page.request
    .get("/api/auth/get-session")
    .then((response) => response.json());
  const cookie = (await context.cookies(baseURL))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const portal = "https://app.vnbot.run";
  const computer = "https://computer.example.test";
  let signedOut = false;
  const csp = await portalFramePolicy(
    baseURL,
    "app.vnbot.run",
    "frame-src 'self'; frame-ancestors 'none'",
    async () => Response.json({ kind: "portal", portalOrigin: portal, frameSrc: [computer] }),
  );
  await page.routeWebSocket(/app\.vnbot\.run|computer\.example\.test/, (socket) => socket.close());
  await context.route(`${portal}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({ json: signedOut ? null : session });
    if (url.pathname === "/api/auth/sign-out") {
      signedOut = true;
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === "/rpc/remoteHosts/list")
      return route.fulfill({
        json: {
          json: {
            kind: "open",
            deviceId: "frame-computer",
            logicalHost: "fixture-computer",
            devices: [
              {
                deviceId: "frame-computer",
                logicalHost: "fixture-computer",
                remoteEnabled: true,
                state: "ready",
              },
            ],
          },
        },
      });
    if (url.pathname === "/rpc/remoteHosts/enter")
      return route.fulfill({ json: { json: { href: `${computer}/remote-enter#fixture-ticket` } } });
    const response = await route.fetch({
      url: new URL(url.pathname + url.search, baseURL).href,
      headers: { ...request.headers(), cookie, origin: new URL(baseURL).origin },
    });
    const headers = { ...response.headers() };
    if (headers["content-type"]?.includes("text/html")) headers["content-security-policy"] = csp;
    return route.fulfill({ response, headers });
  });
  // Only the computer document is a fixture. The portal UI and account session are real harness code.
  await context.route(`${computer}/**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": `frame-ancestors ${portal}` },
      body: `<!doctype html><html lang="vi"><body>
    <p>Phiên máy tính thử</p><button type="button" id="navigate">Mở bot thử</button>
    <button type="button" id="unsafe">Điều hướng không hợp lệ</button><button type="button" id="logout">Đăng xuất</button>
    <script>
      const tell = path => parent.postMessage({type:'vnbot.remote.navigation',path}, '${portal}');
      document.getElementById('navigate').onclick = () => tell('/app/fixture-bot');
      document.getElementById('unsafe').onclick = () => tell('//untrusted.example.test');
      document.getElementById('logout').onclick = () => parent.postMessage({type:'vnbot.remote.signed-out'}, '${portal}');
      tell('/app');
    </script></body></html>`,
    }),
  );
  await page.goto(`${portal}/app`);
  const frame = page.frameLocator('iframe[title="VNBot"]');
  await expect(frame.getByText("Phiên máy tính thử", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${portal}/m/frame-computer/app`);
  const sandbox = await page.locator('iframe[title="VNBot"]').getAttribute("sandbox");
  expect(sandbox).not.toContain("allow-top-navigation");
  await frame.getByRole("button", { name: "Mở bot thử" }).click();
  await expect(page).toHaveURL(`${portal}/m/frame-computer/app/fixture-bot`);
  await frame.getByRole("button", { name: "Điều hướng không hợp lệ" }).click();
  await expect(page).toHaveURL(`${portal}/m/frame-computer/app/fixture-bot`);
  expect(
    await page.locator('iframe[title="VNBot"]').evaluate((element) => {
      try {
        void (element as HTMLIFrameElement).contentWindow!.document;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await frame.getByRole("button", { name: "Đăng xuất", exact: true }).click();
  await expect(page).toHaveURL((url) => url.origin === portal && url.pathname === "/sign-in");
  await expect(page.locator('iframe[title="VNBot"]')).toHaveCount(0);
  // The sign-in page may still be loading through the portal routes.
  await context.unrouteAll({ behavior: "ignoreErrors" });
});

test("an invitation opened before sign-in reaches the computer after sign-in", async ({
  page,
  context,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("The portal test needs the existing web server");
  await signInForPortal(page, `portal-join-${Date.now()}@example.test`);
  const session = await page.request
    .get("/api/auth/get-session")
    .then((response) => response.json());
  const cookie = (await context.cookies(baseURL))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const portal = "https://app.vnbot.run";
  const computer = "https://computer.example.test";
  let entered = 0;
  await page.routeWebSocket(/app\.vnbot\.run|computer\.example\.test/, (socket) => socket.close());
  await context.route(`${portal}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/get-session") return route.fulfill({ json: session });
    if (url.pathname === "/rpc/remoteHosts/enter") {
      entered += 1;
      return route.fulfill({ json: { json: { href: `${computer}/remote-enter#fixture-ticket` } } });
    }
    const response = await route.fetch({
      url: new URL(url.pathname + url.search, baseURL).href,
      headers: { ...request.headers(), cookie, origin: new URL(baseURL).origin },
    });
    const headers = { ...response.headers() };
    if (headers["content-type"]?.includes("text/html"))
      headers["content-security-policy"] = `frame-src 'self' ${computer}`;
    return route.fulfill({ response, headers });
  });
  await context.route(`${computer}/**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": `frame-ancestors ${portal}` },
      body: "<!doctype html><title>Computer</title><p>Computer</p>",
    }),
  );
  // The join page saved the invitation before sending the person to sign in.
  await page.addInitScript(() =>
    sessionStorage.setItem("rakazo-remote-join", "device=join-computer&invite=fixture-invite"),
  );
  // Signed in, the sign-in page moves on to /remote-join inside the app, without a new page load.
  await page.goto(`${portal}/sign-in?next=%2Fremote-join`);
  await expect(page).toHaveURL(`${portal}/m/join-computer/app`);
  expect(entered).toBeGreaterThan(0);
  const src = await page.locator('iframe[title="VNBot"]').getAttribute("src");
  expect(new URLSearchParams(new URL(src ?? "").hash.slice(1)).get("invite")).toBe(
    "fixture-invite",
  );
  await context.unrouteAll({ behavior: "ignoreErrors" });
});

async function signInForPortal(page: Page, email: string) {
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) throw new Error("The portal test needs the existing web server");
  const headers = { origin: new URL(baseURL).origin };
  const sent = await page.request.post("/api/auth/email-otp/send-verification-otp", {
    headers,
    data: { email, type: "sign-in" },
  });
  expect(sent.ok()).toBe(true);
  // This is the existing harness outbox, not a real mailbox or mocked auth endpoint.
  const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";
  const outbox = await page.request.get(`${emailApi}/__e2e/emails`);
  expect(outbox.ok()).toBe(true);
  const messages: unknown = await outbox.json();
  if (!Array.isArray(messages)) throw new Error("Invalid fixture outbox");
  const message = messages.findLast(
    (item) => item && item.to === email && typeof item.text === "string",
  );
  const otp = message?.text.match(
    /(?:Your VNBot sign-in code|Mã đăng nhập VNBot của bạn): (\d{6})/,
  )?.[1];
  if (!otp) throw new Error("Missing fixture sign-in code");
  const signedIn = await page.request.post("/api/auth/sign-in/email-otp", {
    headers,
    data: { email, otp },
  });
  expect(signedIn.ok()).toBe(true);
}

test("the remote entry keeps account switching available while loading, on errors, and without a computer", async ({
  page,
  context,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "en"));
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("The portal test needs the existing web server");
  await signInForPortal(page, `portal-exit-${Date.now()}@example.test`);
  const session = await page.request
    .get("/api/auth/get-session")
    .then((response) => response.json());
  expect(session.user).toBeTruthy();
  const cookie = (await context.cookies(baseURL))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  let signedOut = false;
  let fail = true;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Everything on the public host is intercepted; this never contacts the live portal.
  await page.routeWebSocket(/app\.vnbot\.run/, (socket) => socket.close());
  await context.route("http://app.vnbot.run/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({ json: signedOut ? null : session });
    if (url.pathname === "/api/auth/sign-out") {
      signedOut = true;
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname === "/rpc/remoteHosts/list") {
      await pending;
      return fail
        ? route.fulfill({
            status: 503,
            json: { code: "SERVICE_UNAVAILABLE", message: "Unavailable" },
          })
        : route.fulfill({ json: { json: { kind: "unavailable", devices: [] } } });
    }
    return route.fulfill({
      response: await route.fetch({
        url: new URL(url.pathname + url.search, baseURL).href,
        headers: { ...request.headers(), origin: new URL(baseURL).origin, cookie },
      }),
    });
  });
  try {
    await page.goto("http://app.vnbot.run/app");
    const account = page.getByTestId("account-menu");
    await expect(account).toBeVisible();
    await expect(page.getByRole("status")).toBeVisible();
    await captureScreenshot(page, testInfo, "remote-portal-loading-exit");
    release();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(account).toBeEnabled();
    fail = false;
    await page.getByRole("button", { name: "Thử lại", exact: true }).click();
    await expect(page.getByTestId("remote-portal-empty")).toBeVisible();
    await account.click();
    const logout = page.getByRole("menuitem", { name: "Log out", exact: true });
    await expect(logout).toBeVisible();
    await captureScreenshot(page, testInfo, "remote-portal-empty-account-menu");
    await logout.click();
    await expect(page).toHaveURL((url) => url.pathname === "/sign-in");
    await expect(page.getByRole("textbox", { name: "Email", exact: true })).toHaveValue("");
  } finally {
    release();
  }
});

test("a remembered offline computer is not replaced by the only other ready computer", async ({
  page,
  context,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "vi"));
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error("The portal test needs the existing web server");
  await page.goto("/sign-in");
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('a[href="https://vnbot.run/dieu-khoan"]')).toHaveCount(0);
  await expect(page.locator('a[href="https://vnbot.run/quyen-rieng-tu"]')).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 860 });
  await captureScreenshot(page, testInfo, "remote-portal-auth-no-legal");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await captureScreenshot(page, testInfo, "remote-portal-auth-no-legal-phone");
  await page.setViewportSize({ width: 1280, height: 860 });
  await signInForPortal(page, `portal-remember-${Date.now()}@example.test`);
  const session = await page.request
    .get("/api/auth/get-session")
    .then((response) => response.json());
  const userId = session?.user?.id;
  if (typeof userId !== "string" || userId.length === 0) throw new Error("Missing signed-in user");
  const storageKey = rememberedComputerKey(userId, "http://app.vnbot.run");
  if (storageKey === null) throw new Error("Missing preference key");
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ deviceId: "computer-a" }));
  }, storageKey);
  const cookie = (await context.cookies(baseURL))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  let entered = 0;
  await page.routeWebSocket(/app\.vnbot\.run/, (socket) => socket.close());
  await context.route("http://app.vnbot.run/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/get-session") return route.fulfill({ json: session });
    if (url.pathname === "/rpc/remoteHosts/list") {
      return route.fulfill({
        json: {
          json: {
            kind: "open",
            deviceId: "computer-b",
            logicalHost: "may-b",
            devices: [
              {
                deviceId: "computer-a",
                logicalHost: "may-a",
                remoteEnabled: true,
                state: "offline",
              },
              {
                deviceId: "computer-b",
                logicalHost: "may-b",
                remoteEnabled: true,
                state: "ready",
              },
            ],
          },
        },
      });
    }
    if (url.pathname === "/rpc/remoteHosts/enter") {
      entered += 1;
      return route.fulfill({ json: { json: { href: "https://host.example/should-not-open" } } });
    }
    return route.fulfill({
      response: await route.fetch({
        url: new URL(url.pathname + url.search, baseURL).href,
        headers: { ...request.headers(), origin: new URL(baseURL).origin, cookie },
      }),
    });
  });
  await page.goto("http://app.vnbot.run/app");
  await expect(page.getByTestId("remote-portal-pick-computer-b")).toBeVisible();
  await expect(page.getByText("Ngoại tuyến", { exact: true })).toBeVisible();
  await expect(page.getByTestId("remote-portal-remembered-absent")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thử lại", exact: true })).toBeVisible();
  await expect(page.getByTestId("account-menu")).toBeVisible();
  expect(entered).toBe(0);
  await expect(page).toHaveURL(/app\.vnbot\.run/);
  await page.setViewportSize({ width: 1280, height: 860 });
  await captureScreenshot(page, testInfo, "remote-portal-remembered-offline");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("remote-portal-pick-computer-b")).toBeVisible();
  expect(entered).toBe(0);
  await captureScreenshot(page, testInfo, "remote-portal-remembered-offline-phone");
});
