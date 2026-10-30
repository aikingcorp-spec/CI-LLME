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

for (const os of ["windows", "linux", "mac", "ios", "android", "unknown"]) {
  test(`download block renders ${os} state`, async ({ page }) => {
    await page.goto(`/?os=${os}`);
    const block = page.locator("#download");
    await expect(block).toBeVisible();
    if (os === "windows" || os === "linux") {
      await expect(block.locator(".dl-primary")).toHaveAttribute("aria-disabled", "true");
    } else if (os === "unknown") {
      await expect(block.getByText("Chọn bản cài cho máy của bạn")).toBeVisible();
    } else {
      await expect(block.getByText(/Chưa có bản cho/)).toBeVisible();
    }
  });
}

for (const path of ["/de/", "/docs", "/blog", "/about", "/privacy", "/terms"]) {
  test(`${path} is not built`, async ({ page }) => {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("link", { name: "Về trang chủ", exact: true })).toHaveAttribute("href", "/");
  });
}

test("disabled downloads never expose installer hrefs", async ({ page }) => {
  await page.goto("/?os=unknown");
  await expect(page.locator("#download a[href^='https://dl.vnbot.run/']")).toHaveCount(0);
});

test("enabled Windows post-click opens SmartScreen help", async ({ page }) => {
  await page.route("https://dl.vnbot.run/**", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="VNBot-Setup.exe"',
      },
      body: "x",
    }),
  );
  await page.goto("/?os=windows&flags=windows");
  await Promise.all([page.waitForEvent("download"), page.locator("#download .dl-primary").click()]);
  await expect(page.locator("#dl-live")).toContainText("Đang tải VNBot");
  await expect(page.locator("#smart-help")).toBeVisible();
  await expect(page.locator(".ss-open")).toHaveAttribute("aria-expanded", "true");
});

test("download block switches VI and EN", async ({ page }) => {
  await page.goto("/?os=windows");
  await page.locator("#lang2").click();
  await expect(page.locator("#download h2")).toHaveText("Download VNBot.");
  await expect(page.locator("#download .dl-chip")).toHaveText("Free · Preview");
});
