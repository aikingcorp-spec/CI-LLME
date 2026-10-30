import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, chooseOption, readSignInCode } from "./helpers";

const WIDTH = 390;
// Smallest comfortable touch target in CSS pixels.
const TAP_SIZE = 32;

test.use({ viewport: { width: WIDTH, height: 844 }, hasTouch: true, isMobile: true });

test.afterEach(async ({ page }) => {
  // Finish intercepted responses before the browser context is disposed.
  await page.unrouteAll({ behavior: "wait" });
});

async function expectNoHorizontalOverflow(page: Page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(WIDTH);
}

async function expectTappable(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(TAP_SIZE);
  expect(box!.width).toBeGreaterThanOrEqual(TAP_SIZE);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(WIDTH);
  // Trial click checks that nothing covers the control, without pressing it.
  await control.click({ trial: true });
}

async function expectNoEnglish(page: Page, leftovers: string[]) {
  const text = await page.locator("body").innerText();
  for (const english of leftovers) expect(text).not.toContain(english);
}

test("a new Vietnamese user reaches the first chat on a 390px phone", async ({
  page,
}, testInfo) => {
  let surveyDue = true;
  let modelDue = true;
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "vi"));
  // Local servers do not bill and ship a default model, so stand in for a fresh deployment.
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsSignupSurvey: surveyDue, needsModel: modelDue } },
    });
  });
  await page.route("**/rpc/onboarding/signupSurvey", (route) => {
    surveyDue = false;
    return route.fulfill({ json: { json: { ok: true } } });
  });

  // Sign in: email, then the code from the e2e mailbox.
  const email = `onboarding-vi-390-${Date.now()}@rakazo.test`;
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Bắt đầu với VNBot" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expectNoEnglish(page, ["Get started", "Send code", "Email"]);
  await expectNoHorizontalOverflow(page);
  await expectTappable(page.getByRole("button", { name: "Gửi mã", exact: true }));
  await captureScreenshot(page, testInfo, "01-sign-in-vi-390");

  await page.getByLabel("Thư điện tử", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Gửi mã", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Kiểm tra email của bạn" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const code = await readSignInCode(page, email);
  await page.getByLabel("Mã đăng nhập 6 số").fill(code);

  // Survey.
  await expect(page.getByRole("heading", { name: "Chào mừng đến với VNBot" })).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding\/survey$/);
  await expect(page.getByText("Bạn sẽ dùng VNBot thế nào?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Nhập bot có sẵn" })).toBeVisible();
  await expectNoEnglish(page, ["Welcome to", "How will you use", "Personal", "Import an agent"]);
  await expectNoHorizontalOverflow(page);
  await expectTappable(page.getByRole("button", { name: "Cá nhân", exact: true }));
  await expectTappable(page.getByRole("button", { name: "Công việc", exact: true }));
  await expectTappable(page.getByRole("button", { name: "Tiếp tục", exact: true }));
  await captureScreenshot(page, testInfo, "02-survey-vi-390");

  await page.getByRole("button", { name: "Cả hai", exact: true }).tap();
  const teamSize = page.getByRole("combobox", { name: "Nhóm của bạn có bao nhiêu người?" });
  await expectTappable(teamSize);
  await chooseOption(teamSize, { index: 1 });
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Tiếp tục", exact: true }).tap();

  // Model step, where it can be skipped.
  await expect(page.getByRole("heading", { name: "Kết nối mô hình" })).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding\/model$/);
  await expectNoEnglish(page, ["Connect a model", "Skip for now", "Continue", "Provider"]);
  await expectNoHorizontalOverflow(page);
  await expectTappable(page.getByRole("combobox", { name: "Nhà cung cấp" }));
  await expect(page.getByRole("button", { name: "Tiếp tục", exact: true })).toBeDisabled();
  const skip = page.getByRole("button", { name: "Bỏ qua lúc này", exact: true });
  await expectTappable(skip);
  await captureScreenshot(page, testInfo, "03-model-vi-390");

  modelDue = false;
  await skip.tap();

  // First chat.
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(page.getByRole("combobox", { name: "Nhắn cho Chief" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Bạn muốn mình làm gì trước?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Công việc hằng ngày/ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expectNoEnglish(page, ["What do you want me on first?", "Day-to-day work"]);
  await expectNoHorizontalOverflow(page);
  await page.mouse.move(1, 1);
  await captureScreenshot(page, testInfo, "04-first-chat-vi-390");
});
