import type { Page, TestInfo } from "@playwright/test";
import { devices, test } from "@playwright/test";

// The hero and closing call to action pick actions for the visitor's platform; record the macOS and iPhone variants.
const { defaultBrowserType: _, ...iPhone } = devices["iPhone 15"];
test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

// "/" and "/en/" are the only landing pages; the 404 page shares their wordmark.
async function openHomepage(page: Page, path = "/") {
  await page.goto(path);
  await page.locator("nav.top img.wmimg").waitFor();
  await page.waitForLoadState("networkidle");
}

// The gallery rejects images taller than 10,000px, so long pages are split into parts.
const MAX_SCREENSHOT_HEIGHT = 9_000;

/** Visual record for the CI screenshot gallery. No content assertions. */
async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const { width, height } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.scrollHeight,
  }));
  const parts = Math.ceil(height / MAX_SCREENSHOT_HEIGHT);
  for (let part = 0; part < parts; part++) {
    const partName = part === 0 ? name : `${name}-${part + 1}`;
    const screenshotPath = testInfo.outputPath(`${partName}.png`);
    const y = part * MAX_SCREENSHOT_HEIGHT;
    await page.screenshot({
      animations: "disabled",
      caret: "hide",
      fullPage: true,
      scale: "css",
      clip: { x: 0, y, width, height: Math.min(MAX_SCREENSHOT_HEIGHT, height - y) },
      path: screenshotPath,
    });
    await testInfo.attach(partName, { contentType: "image/png", path: screenshotPath });
  }
}

test("homepage screenshots", async ({ page }, testInfo) => {
  await openHomepage(page);
  await captureScreenshot(page, testInfo, "01-marketing-homepage");

  await openHomepage(page, "/en/");
  await captureScreenshot(page, testInfo, "01-marketing-homepage-en");

  await openHomepage(page, "/removed-page/");
  await captureScreenshot(page, testInfo, "03-marketing-not-found");
});

test.describe("on an iPhone", () => {
  test.use(iPhone);

  test("homepage screenshot", async ({ page }, testInfo) => {
    await openHomepage(page);
    await captureScreenshot(page, testInfo, "02-marketing-homepage-iphone");
  });
});
