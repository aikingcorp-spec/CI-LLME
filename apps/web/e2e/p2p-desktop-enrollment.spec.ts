import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { fetchLoopback } from "./p2p-network";

test.use({
  video: "off",
  launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
});

test("native enrollment explains verification and confirms the registered account", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("rakazo.uiLocale", "vi");
    window.rakazoDesktop = {
      platform: "linux",
      p2p: {
        isLocal: async () => true,
        sendCode: async (email) => {
          if (email !== "person@example.test") throw new Error("Wrong account");
        },
        signIn: async () => true,
        enroll: async (email, otp) => {
          if (email !== "person@example.test" || otp !== "123456") throw new Error("Wrong proof");
          return true;
        },
      },
    };
  });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/get-session")
      await route.fulfill({
        json: {
          user: { id: "fixture-user", email: "person@example.test", name: "Fixture" },
          session: {
            id: "fixture-session",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        },
      });
    else if (path.startsWith("/api/") || path.startsWith("/rpc/"))
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
    else {
      const response = await fetchLoopback(route);
      if (response) await route.fulfill({ response });
    }
  });
  await page.goto("/app/pairing");
  await page.getByRole("button", { name: "Gửi mã", exact: true }).click();
  await expect(page.getByLabel("Mã email", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "desktop-remote-access-code");
  await page.getByLabel("Mã email", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Bật truy cập từ xa", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Đã bật truy cập từ xa cho tài khoản này.");
  await captureScreenshot(page, testInfo, "desktop-remote-access-enabled");
});
