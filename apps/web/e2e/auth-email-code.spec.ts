import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("mocked email code keeps the invite address when the code is wrong and the email changes", async ({
  page,
}, testInfo) => {
  // Every auth route below is fulfilled here. Nothing in this test is a mailbox or a real code.
  const invitePath = "/invite/token_1";
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "vi"));
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: true,
        emailCode: true,
        passwordReset: false,
        resetUrl: null,
        sso: null,
      },
    }),
  );
  await page.route("**/api/auth/email-otp/send-verification-otp", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await page.route("**/api/auth/sign-in/email-otp", (route) =>
    route.fulfill({ status: 400, json: { code: "INVALID_OTP", message: "Invalid code" } }),
  );
  await page.goto(`/sign-in?next=${encodeURIComponent(invitePath)}`);
  expect(new URL(page.url()).searchParams.get("next")).toBe(invitePath);
  await page.locator('input[type="email"]').fill("mai@example.test");
  await page.getByRole("button", { name: "Gửi mã", exact: true }).click();
  await expect(page.getByText("mai@example.test", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Gửi lại mã", exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("next")).toBe(invitePath);
  await captureScreenshot(page, testInfo, "email-code-entry-vi");
  await page.locator('input[autocomplete="one-time-code"]').fill("111111");
  await expect(page.getByRole("alert")).toHaveText("Mã không đúng");
  await captureScreenshot(page, testInfo, "email-code-invalid-vi");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "email-code-mobile-vi");
  await page.getByRole("button", { name: "Đổi email khác", exact: true }).click();
  await expect(page.locator('input[type="email"]')).toHaveValue("mai@example.test");
  expect(new URL(page.url()).pathname).toBe("/sign-in");
  expect(new URL(page.url()).searchParams.get("next")).toBe(invitePath);
});
