import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

// Evidence capture, not a regression test: run with VNBOT_D1_SCREENSHOTS=1, a free WEB_PORT and
// VITE_DEFAULT_UI_LOCALE=vi so the default locale is the one shown.
test.skip(!process.env.VNBOT_D1_SCREENSHOTS, "Set VNBOT_D1_SCREENSHOTS=1 to capture these");

const EMAIL = "e2e@example.com";

async function capture(page: Page, name: string) {
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(process.env.VNBOT_D1_SCREENSHOTS_DIR ?? test.info().outputDir, `${name}.png`),
  });
}

/** Stubs the auth API so the session appears only once the code is accepted. */
async function stubAuth(page: Page) {
  let signedIn = false;
  const user = {
    id: "user-e2e",
    email: EMAIL,
    name: "e2e",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({
      json: signedIn
        ? {
            user,
            session: {
              id: "session-e2e",
              userId: user.id,
              token: "fake-token",
              expiresAt: "2099-01-01T00:00:00.000Z",
              createdAt: user.createdAt,
              updatedAt: user.updatedAt,
            },
          }
        : null,
    }),
  );
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: false,
        emailCode: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
      },
    }),
  );
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await page.route("**/api/auth/sign-in/email-otp", (route) => {
    signedIn = true;
    return route.fulfill({ json: { token: "fake-token", user } });
  });
}

async function reachCodeStep(page: Page, sendCode: string) {
  await page.goto("/sign-in");
  await page.locator("#email").fill(EMAIL);
  await page.getByRole("button", { name: sendCode, exact: true }).click();
}

async function enterCode(page: Page) {
  await page.locator('input[autocomplete="one-time-code"]').fill("123456");
}

test("web sign-in steps in Vietnamese", async ({ page }) => {
  await stubAuth(page);
  await page.goto("/sign-in");
  await expect(page.getByRole("button", { name: "Gửi mã", exact: true })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.locator("#email").fill(EMAIL);
  await capture(page, "01-web-email");

  await page.getByRole("button", { name: "Gửi mã", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Kiểm tra email của bạn" })).toBeVisible();
  await expect(page.getByText(EMAIL)).toBeVisible();
  await capture(page, "02-web-code");

  await enterCode(page);
  await expect(page.getByRole("heading", { name: "Chọn máy" })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(3);
  await expect(page.getByRole("radio", { name: /Máy tính này/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /VNBot Cloud/ })).toBeDisabled();
  await expect(page.getByText("Sắp có", { exact: true })).toBeVisible();
  await capture(page, "03-web-machine");

  await page.getByRole("radio", { name: /Máy của bạn/ }).check();
  await page.locator("#machine-address").fill("https://vnbot.example.com");
  await capture(page, "04-web-own-machine-address");
});

test("web machine step in English", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "en"));
  await stubAuth(page);
  await reachCodeStep(page, "Send code");
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await enterCode(page);
  await expect(page.getByRole("heading", { name: "Choose a machine" })).toBeVisible();
  await expect(page.getByRole("radio", { name: /VNBot Cloud/ })).toBeDisabled();
  await expect(page.getByText("Coming soon", { exact: true })).toBeVisible();
  await capture(page, "03-web-machine-en");
});
