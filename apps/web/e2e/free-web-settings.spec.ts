import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("legacy billing links open General without a paywall", async ({ page }, testInfo) => {
  await signup(page, `free-web-${Date.now()}@example.test`, "password12", "Web tester");
  await completeOnboarding(page);
  for (const query of ["settings=billing", "settings=wallet", "plans"]) {
    await page.goto(`/app?${query}`);
    const settings = page.locator('[data-settings-section="general"]');
    await expect(settings).toBeVisible();
    await expect(page.getByTestId("billing-paywall")).toHaveCount(0);
    await expect(page.getByTestId("settings-nav-billing")).toHaveCount(0);
    await expect(page.getByTestId("settings-nav-wallet")).toHaveCount(0);
  }
  await captureScreenshot(page, testInfo, "free-web-general-settings");
});
