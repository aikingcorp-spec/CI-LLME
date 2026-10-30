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

test("gated primary button has 0.6 opacity, not-allowed cursor, download icon svg, and detected info icon", async ({
  page,
}) => {
  await page.goto("/?os=windows");
  const primary = page.locator("#download .dl-primary");
  await expect(primary).toBeVisible();
  await expect(primary).toHaveAttribute("aria-disabled", "true");
  await expect(primary).not.toHaveAttribute("href");
  const styles = await primary.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, cursor: cs.cursor, tag: el.tagName, tabIndex: el.tabIndex };
  });
  expect(styles.opacity).toBe("0.6");
  expect(styles.cursor).toBe("not-allowed");
  expect(styles.tag).toBe("SPAN");
  expect(styles.tabIndex).toBe(-1);

  const dlSvg = primary.locator('svg[data-icon="download"]');
  await expect(dlSvg).toBeVisible();
  await expect(dlSvg).toHaveAttribute("aria-hidden", "true");
  await expect(primary.locator("img")).toHaveCount(0);

  const infoSvg = page.locator('#download .dl-detected svg[data-icon="info"]');
  await expect(infoSvg).toBeVisible();
  await expect(infoSvg).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#download .dl-detected")).toContainText("Đã nhận diện: Windows");
});

test("copy button shows copy icon, hides text at 390px with aria-label, and is disabled when gated", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?os=windows");
  const copyBtn = page.locator("#download .dl-copy");
  await expect(copyBtn).toBeVisible();
  await expect(copyBtn).toHaveAttribute("aria-label", "Sao chép");
  await expect(copyBtn).toHaveAttribute("aria-disabled", "true");
  await expect(copyBtn.locator('svg[data-icon="copy"]')).toBeVisible();
  await expect(copyBtn.locator(".dl-copy-text")).toBeHidden();

  await copyBtn.click({ force: true });
  await expect(copyBtn).not.toContainText("Đã chép");
  await expect(page.locator("#dl-live")).toHaveText("");
});

test("unsupported OS state renders plain text links without button-like spans", async ({ page }) => {
  await page.goto("/?os=mac");
  const main = page.locator("#dlmain");
  await expect(main.locator(".btn")).toHaveCount(0);
  await expect(main.locator(".dl-buttons")).toHaveCount(0);
  await expect(main.locator(".dl-unsup-links")).toHaveText("Tải cho Windows · Tải cho Linux");
  await expect(main.locator(".dl-text-link")).toHaveCount(2);
  await expect(main.locator(".dl-text-link").first()).toHaveAttribute("aria-disabled", "true");

  await page.goto("/?os=mac&flags=windows,linux");
  await expect(main.locator("a.dl-text-link")).toHaveCount(2);
  await expect(main.locator("a.dl-text-link").nth(0)).toHaveText("Tải cho Windows");
  await expect(main.locator("a.dl-text-link").nth(1)).toHaveText("Tải cho Linux");
});

test("standalone #requirements is removed and install steps match origin/main", async ({ page }) => {
  await page.goto("/?os=windows");
  await expect(page.locator("#requirements")).toHaveCount(0);
  await expect(page.locator('#download a[href="#requirements"]')).toHaveCount(0);
  await expect(page.locator('[data-i="s1"]')).toContainText("Mac mini, PC văn phòng hoặc VPS riêng");
  await expect(page.locator('[data-i="s2"]')).toHaveText("Đăng nhập bằng email và mã");
  await expect(page.locator('[data-i="s3"]')).toContainText("Kết nối mô hình và giao việc đầu tiên");

  await page.goto("/en/?os=windows");
  await expect(page.locator("#requirements")).toHaveCount(0);
  await expect(page.locator('[data-i="s1"]')).toHaveText(
    "Install the app on the machine that will run your bots (Mac mini, office PC or your own VPS)",
  );
  await expect(page.locator('[data-i="s2"]')).toHaveText("Sign in with email and a code");
  await expect(page.locator('[data-i="s3"]')).toHaveText("Connect your model and give your first bot a job");
});

test("release notes is non-link text when gated and a link when enabled", async ({ page }) => {
  await page.goto("/?os=windows");
  await expect(page.locator("#download .dl-links")).toContainText("Ghi chú phát hành");
  await expect(page.locator("#download .dl-links a", { hasText: "Ghi chú phát hành" })).toHaveCount(0);

  await page.goto("/?os=windows&flags=windows");
  await expect(page.locator("#download .dl-links a", { hasText: "Ghi chú phát hành" })).toHaveCount(1);
});

test("MSI click shows .msi filename in SmartScreen step 2, checksum panel, and retry link, and close restores focus", async ({
  page,
}) => {
  await page.route("https://dl.vnbot.run/**", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="VNBot-0.3.6-win-x64.msi"',
      },
      body: "x",
    }),
  );
  await page.goto("/?os=windows&flags=windows");
  const msiLink = page.locator("#dlother a.platform-action", { hasText: /msi/i });
  await Promise.all([page.waitForEvent("download"), msiLink.click()]);

  const card = page.locator("#smart-help");
  await expect(card).toBeVisible();
  await expect(card.locator(".dl-retry")).toHaveAttribute(
    "href",
    "https://dl.vnbot.run/desktop/VNBot-0.3.6-win-x64.msi",
  );
  const step2 = card.locator("#smart-steps ol li").nth(1);
  await expect(step2).toContainText("VNBot-0.3.6-win-x64.msi");
  await expect(step2).not.toContainText(".exe");

  await card.locator(".ss-checksum-open").click();
  const checksum = card.locator("#ss-checksum");
  await expect(checksum).toBeVisible();
  await expect(checksum).toContainText("Get-FileHash .\\VNBot-0.3.6-win-x64.msi -Algorithm SHA256");
  await expect(checksum).not.toContainText(".exe");

  await card.locator(".ss-close").click();
  await expect(card).toBeHidden();
  await expect(msiLink).toBeFocused();

  const hintOpen = page.locator("#download .ss-open");
  await hintOpen.click();
  await expect(card).toBeVisible();
  await card.locator(".ss-close").click();
  await expect(card).toBeHidden();
  await expect(hintOpen).toBeFocused();
});
