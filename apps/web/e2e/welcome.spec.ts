import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const theme of ["dark", "light"] as const) {
  test(`welcome keeps the designed artwork and readable copy in ${theme}`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: theme });
    await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "vi");
    const welcome = page.locator('[data-rakazo-surface="welcome"]');
    const start = welcome.getByRole("button", { name: "Bắt đầu" });
    await expect(start).toBeVisible();
    await expect(welcome.getByRole("link", { name: "Đăng nhập", exact: true })).toBeVisible();
    await expect(welcome.locator("main p")).toHaveText(
      "Đội bot luôn sẵn sàng,nhận việc thật từ bạn.",
    );
    // biome-ignore lint/performance/useDomNodeTextContent: rendered text detects missing font output seen in this environment.
    expect(await welcome.locator("main").innerText()).toContain("Bắt đầu");
    await expect(welcome.locator('main [aria-hidden="true"] svg')).toHaveCount(5);
    const logo = welcome.getByRole("img", { name: "VNBot", exact: true });
    await expect(logo).toBeVisible();
    expect(
      await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await captureScreenshot(page, testInfo, `vnbot-welcome-${theme}-vi`);

    await page.getByTestId("language-switch").click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(2);
    await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
    await expect(start).toHaveCount(0);
    await expect(welcome.getByRole("button", { name: "Get started" })).toBeVisible();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByTestId("language-switch")).toContainText("English");
    await captureScreenshot(page, testInfo, `vnbot-welcome-${theme}-en`);
    await welcome.getByRole("button", { name: "Get started" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Sign in to VNBot" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
