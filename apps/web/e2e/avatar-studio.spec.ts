import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPanelTab, signup } from "./helpers";

async function saveAvatar(page: Page, choose: () => Promise<void>) {
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await choose();
  await saved;
}

test("bot settings open Avatar Studio on the Bot tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@example.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByText("Avatar Studio", { exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Bot", exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Upload", exact: true })).toBeVisible();
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();
  await expect(studio.getByRole("tab", { name: "VNBot", exact: true })).toBeVisible();
  await expect(studio.getByRole("tab", { name: "Classic", exact: true })).toBeVisible();

  const sen = studio.getByTestId("vnbot-shape-sen");
  await saveAvatar(page, () => sen.click());
  await expect(sen).toHaveAttribute("aria-pressed", "true");
  await expect(studio.locator("[data-vnbot-shape=sen]").first()).toBeVisible();

  await saveAvatar(page, () => studio.getByRole("button", { name: "Color #10B981" }).click());
  await expect(sen).toHaveAttribute("aria-pressed", "true");
  await expect(studio.locator("[data-vnbot-shape=sen]").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "avatar-studio-vnbot");

  await studio.getByRole("tab", { name: "Classic", exact: true }).click();
  const wedge = studio.getByRole("button", { name: "wedge", exact: true });
  await expect(studio.getByTestId("avatar-studio-default")).toBeVisible();
  await saveAvatar(page, () => wedge.click());
  await expect(wedge).toHaveAttribute("aria-pressed", "true");
  await expect(studio.locator(".bot-character-eyes").first()).toBeVisible();
  await expect(studio.locator("[data-vnbot-avatar]")).toHaveCount(0);

  await studio.getByRole("tab", { name: "VNBot", exact: true }).click();
  await saveAvatar(page, () => sen.click());
  await expect(sen).toHaveAttribute("aria-pressed", "true");
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await expect(studio).toBeHidden();

  await page.reload();
  await openBotPanelTab(page, "Computer");
  await expect(
    page.getByTestId("avatar-studio-trigger").locator("[data-vnbot-shape=sen]"),
  ).toBeVisible();
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  const reopened = page.getByTestId("avatar-studio");
  await expect(reopened.getByRole("tab", { name: "VNBot", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(reopened.getByTestId("vnbot-shape-sen")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "avatar-studio-vnbot-saved");
});
