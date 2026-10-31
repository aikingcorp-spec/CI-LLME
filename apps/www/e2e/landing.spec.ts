import { expect, test } from "@playwright/test";

const exe = "https://dl.vnbot.run/desktop/VNBot-Setup-0.3.6-x64.exe";
const msi = "https://dl.vnbot.run/desktop/VNBot-0.3.6-win-x64.msi";
const sha = "8682aa010f9280cb21c88473022073b61e00694da365b4766309c7e093c9dde3";
const sections = ["hero", "tinh-nang", "doi-bot", "cach-dung", "tai-ve", "ban-web", "hoi-dap"];

for (const locale of [{ path: "/", lang: "vi", copied: "Đã chép", copy: "Sao chép" },
  { path: "/en/", lang: "en", copied: "Copied", copy: "Copy" }]) {
  test(`${locale.lang}: landing content and downloads`, async ({ page }) => {
    await page.goto(locale.path);
    await expect(page.locator("html")).toHaveAttribute("lang", locale.lang);
    for (const id of sections) await expect(page.locator(`#${id}`)).toHaveCount(1);
    await expect(page.locator(".hero .btn-win")).toHaveAttribute("href", exe);
    await expect(page.locator(".hero .btn-win")).toHaveAttribute("download", "");
    await expect(page.locator(".hero .btn-web")).toHaveAttribute("href", "https://app.vnbot.run");
    await expect(page.locator(".hero .msi a")).toHaveAttribute("href", msi);
    await expect(page.locator(".hero .msi a")).toHaveAttribute("download", "");
    await expect(page.locator(".hero .msi")).toContainText("185 MB");
    await expect(page.locator(".hero .meta")).toContainText("170 MB");
    await expect(page.locator(".facts [data-sha]")).toHaveText(sha);
    await expect(page.locator(".hero [data-sha]")).toHaveAttribute("title", sha);
    await expect(page.locator(".hero [data-sha]")).toHaveText("8682aa01…c9dde3");
    await expect(page.locator(".faq details")).toHaveCount(7);
    await expect(page.locator(".faq details").nth(1)).toHaveAttribute("open", "");
    await expect(page.locator('a[href*="notes"], a[href*="releases"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /release notes|ghi chú phát hành/i })).toHaveCount(0);
    await expect(page.locator('img[src*="non.svg"], img[src*="flag"], img[src*="_rejects"]')).toHaveCount(0);
    await expect(page.locator('.nav .lang')).toHaveAttribute('href', locale.lang === 'vi' ? '/en/' : '/');
    for (const chip of await page.locator(".chip").all()) {
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      await expect(chip).not.toHaveAttribute("href");
      expect(await chip.evaluate(el => el instanceof HTMLElement && el.tabIndex)).toBe(-1);
      expect(await chip.evaluate(el => el.tagName)).toBe("SPAN");
    }
    const note = page.locator(".hero .ss");
    await expect(note).toContainText(locale.lang === "vi" ? "có thể hiện cảnh báo" : "may show a SmartScreen warning");
    await expect(page.locator("body")).not.toContainText("sẽ cảnh báo");
  });

  test(`${locale.lang}: SHA copy announces success for two seconds`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(locale.path);
    const copy = page.locator(".hero .copy");
    await expect(copy).toHaveAttribute("aria-live", "polite");
    await copy.click();
    await expect(copy).toHaveText(locale.copied);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sha);
    await expect(copy).toHaveText(locale.copy, { timeout: 4000 });
  });

  for (const width of [390, 1280]) {
    test(`${locale.lang}: equal hero actions at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(locale.path);
      await page.evaluate(() => document.fonts.ready);
      const boxes = await page.locator(".hero .ctas .btn").evaluateAll(buttons => buttons.map(button => {
        const label = button.querySelector(".lbl");
        if (!label?.firstChild) throw new Error("Missing CTA label");
        const range = document.createRange();
        range.selectNode(label.firstChild);
        return { width: button.clientWidth, height: button.clientHeight, fits: button.scrollWidth <= button.clientWidth,
          lines: range.getClientRects().length };
      }));
      expect(boxes).toHaveLength(2);
      expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes[0].height - boxes[1].height)).toBeLessThanOrEqual(1);
      for (const box of boxes) { expect(box.fits).toBe(true); expect(box.lines).toBe(1); }
      if (width === 390) {
        for (const selector of [".hero .btn-win", ".hero .btn-web", ".hero .ss"]) {
          const box = await page.locator(selector).boundingBox();
          expect(box).not.toBeNull();
          if (!box) throw new Error(`Missing ${selector}`);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(844);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      }
    });
  }

  test(`${locale.lang}: reduced motion leaves content visible`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(locale.path);
    for (const element of await page.locator("[data-reveal], .hero .m").all()) {
      await expect(element).toHaveCSS("opacity", "1");
      await expect(element).toHaveCSS("transform", "none");
    }
    await expect(page.locator(".marq .row")).toHaveCSS("animation-name", "none");
  });

  test(`${locale.lang}: explicit and system dark themes invert the web card`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(locale.path);
    await expect(page.locator(".webb .card")).toHaveCSS("background-color", "rgb(23, 23, 28)");
    await page.goto(`${locale.path}?theme=dark`);
    await expect(page.locator(".webb .card")).toHaveCSS("background-color", "rgb(243, 242, 237)");
    await expect(page.locator(".nav .wm-dark")).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(locale.path);
    await expect(page.locator(".webb .card")).toHaveCSS("background-color", "rgb(243, 242, 237)");
  });

  test(`${locale.lang}: no JavaScript still shows the full page`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${baseURL}${locale.path}`);
    for (const element of await page.locator("[data-reveal], .hero .m").all()) {
      await expect(element).toHaveCSS("opacity", "1");
    }
    await expect(page.locator(".hero .meta")).toContainText("170 MB");
    await context.close();
  });
}
