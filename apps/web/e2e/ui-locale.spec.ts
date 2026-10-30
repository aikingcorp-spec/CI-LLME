import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings language picker offers Vietnamese and English, switches, and survives reload", async ({
  page,
}, testInfo) => {
  await signup(page, `ui-locale-${Date.now()}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);
  const settings = await openUserSettings(page);
  const picker = settings.getByTestId("ui-locale-select");

  await picker.click();
  await expect(page.getByRole("option", { name: "日本語", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "עברית", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Tiếng Việt", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "English", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker");

  await page.getByRole("option", { name: "Tiếng Việt", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Chung", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Tài khoản", exact: true })).toBeVisible();
  await expect(picker).toHaveText("Tiếng Việt");
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await captureScreenshot(page, testInfo, "ui-locale-settings-vi");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.getByTestId("ui-locale-select")).toHaveText("Tiếng Việt");

  await page.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("ui-locale-select")).toHaveText("English");
});
