import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("bot settings open Avatar Studio on the Bot tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@rakazo.test`, "password12", "Avatar Studio");
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

  await expect(studio.getByRole("tablist", { name: "Icon set" }).getByRole("tab")).toHaveCount(2);
  await expect(studio.getByRole("tab", { name: "VNBot", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const tiles = studio.locator('[data-testid^="vnbot-shape-"]');
  await expect(tiles).toHaveCount(5);
  await expect(tiles.first()).toHaveAttribute("data-testid", "vnbot-shape-non");
  await studio.getByTestId("vnbot-shape-non").click();
  await expect(studio.getByTestId("vnbot-shape-non")).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "avatar-studio-vnbot-shapes");
  await studio.getByRole("tab", { name: "Classic", exact: true }).click();
  const defaultLook = studio.getByTestId("avatar-studio-default");
  const wedge = studio.getByRole("button", { name: "wedge", exact: true });
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");

  await wedge.click();
  await expect(wedge).toHaveAttribute("aria-pressed", "true");
  await expect(defaultLook).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".rakazo-organic-avatar")).toHaveCount(0);

  await defaultLook.click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".rakazo-organic-avatar")).toHaveCount(1);
  await expect(studio.locator(".rakazo-organic-avatar-eyes").first()).toBeVisible();

  await studio.getByRole("button", { name: "Color #EAB308" }).click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");

  await wedge.click();
  await studio.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(defaultLook).toHaveAttribute("aria-pressed", "true");
  await expect(wedge).toHaveAttribute("aria-pressed", "false");
  await expect(studio.locator(".rakazo-organic-avatar")).toHaveCount(1);

  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
  await studio.getByRole("tab", { name: "Classic", exact: true }).click();
  await expect(studio.locator(".rakazo-organic-avatar").first()).toBeVisible();
  await studio.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await page.getByTestId("bot-settings-trigger").click();
  await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
  await expect(
    page.getByTestId("avatar-studio").getByRole("tab", { name: "Classic", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await captureScreenshot(page, testInfo, "avatar-studio-classic-set");
});

for (const avatarSet of ["rakazo", "organic"]) {
  test(`saved ${avatarSet} opens Classic in the picker`, async ({ page }) => {
    await signup(
      page,
      `legacy-${avatarSet}-${Date.now()}@rakazo.test`,
      "password12",
      "Legacy avatar",
    );
    await completeOnboarding(page);
    await page.waitForURL(/\/app\/[^/]+$/);
    const botId = page.url().split("/").pop()!;
    await rpc(page, "bots/update", { botId, avatarSet, color: "#10B981" });
    await page.reload();
    await page.getByTestId("bot-settings-trigger").click();
    await page.getByTestId("bot-settings").getByTestId("avatar-studio-trigger").click();
    const studio = page.getByTestId("avatar-studio");
    await expect(studio.getByRole("tab", { name: "Classic", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(studio.locator(".rakazo-organic-avatar")).toHaveCount(1);
    await expect(studio.locator(".rakazo-logo-avatar")).toHaveCount(0);
  });
}
