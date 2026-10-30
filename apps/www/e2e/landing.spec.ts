import { expect, test } from "@playwright/test";

test("vi landing at / has the v4 wordmark and a soon label", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");

  const wordmark = page.locator("nav.top img.wmimg");
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveAttribute("src", "/landing/img/vnbot-wordmark-v4-light.svg");
  await expect
    .poll(() => wordmark.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);

  await expect(page.getByText("Sắp có").first()).toBeVisible();
  expect(await page.content()).not.toMatch(/rakazo/i);
});

test("en landing at /en/ loads", async ({ page }) => {
  await page.goto("/en/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByText(/coming soon/i).first()).toBeVisible();
  expect(await page.content()).not.toMatch(/rakazo/i);
});

for (const path of ["/de/", "/docs", "/blog", "/about", "/privacy", "/terms"]) {
  test(`${path} is not built`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Về trang chủ", exact: true })).toHaveAttribute("href", "/");
  });
}
