import { expect, test } from "@playwright/test";

const exe = "https://dl.vnbot.run/desktop/VNBot-Setup-0.3.7-x64.exe";
const msi = "https://dl.vnbot.run/desktop/VNBot-0.3.7-win-x64.msi";
const sha = "1670dc906f10f8e3c5848f01f9f61659fb784336d3627a631cfcbf1a16eb9786";
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
    await expect(page.locator(".hero .msi a").first()).toHaveAttribute("href", msi);
    await expect(page.locator(".hero .msi a").first()).toHaveAttribute("download", "");
    await expect(page.locator(".hero .msi").first()).toContainText("183 MB");
    await expect(page.locator(".hero .meta")).toContainText("168 MB");
    await expect(page.locator(".facts [data-sha]")).toHaveText(sha);
    await expect(page.locator(".hero [data-sha]")).toHaveAttribute("title", sha);
    await expect(page.locator(".hero [data-sha]")).toHaveText("1670dc90…eb9786");
    await expect(page.locator(".faq details")).toHaveCount(7);
    await expect(page.locator(".faq details").nth(1)).toHaveAttribute("open", "");
    await expect(page.locator('a[href*="notes"], a[href*="releases"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /release notes|ghi chú phát hành/i })).toHaveCount(0);
    // D012 (2026-10-31): the VNBot app icon (felt Nón + VN flag) is allowed on the landing as the nav logo.
    await expect(page.locator('img[src*="non.svg"], img[src*="_rejects"]')).toHaveCount(0);
    await expect(page.locator('header.nav img.nav-icon[src="/landing/img/vnbot-app-icon-128.png"]')).toHaveCount(1);
    // D012 addendum 2026-10-31 22:57: icon also allowed in the footer.
    await expect(page.locator('footer img.footer-icon[src="/landing/img/vnbot-app-icon-128.png"]')).toHaveCount(1);
    await expect(page.locator('.nav .lang')).toHaveAttribute('href', locale.lang === 'vi' ? '/en/' : '/');
    const languageLink = page.locator(".nav .lang");
    await expect(languageLink).toHaveAttribute("lang", locale.lang === "vi" ? "en" : "vi");
    await expect(languageLink).toHaveAttribute("hreflang", locale.lang === "vi" ? "en" : "vi");
    await expect(languageLink).toHaveAttribute("aria-label", locale.lang === "vi" ? "English" : "Tiếng Việt");
    for (const chip of await page.locator(".chip").all()) {
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      await expect(chip).not.toHaveAttribute("href");
      expect(await chip.evaluate(el => el instanceof HTMLElement && el.tabIndex)).toBe(-1);
      expect(await chip.evaluate(el => el.tagName)).toBe("SPAN");
    }
    const note = page.locator(".hero .ss");
    await expect(note).toContainText(locale.lang === "vi" ? "có thể hiện cảnh báo" : "Windows SmartScreen may show a warning");
    await expect(page.locator("body")).not.toContainText("sẽ cảnh báo");
  });

  for (const width of [1440, 1280]) {
    test(`${locale.lang}: hero heading has two lines at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(locale.path);
      await page.evaluate(() => document.fonts.ready);
      const lines = await page.locator(".hero h1").evaluate(heading => {
        const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
        const rows: { top: number; words: string[] }[] = [];
        let node = walker.nextNode();
        while (node) {
          for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            for (const rect of range.getClientRects()) {
              const row = rows.find(row => Math.abs(row.top - rect.top) < 1);
              if (row) row.words.push(match[0]);
              else rows.push({ top: rect.top, words: [match[0]] });
            }
          }
          node = walker.nextNode();
        }
        return rows.sort((a, b) => a.top - b.top).map(row => row.words.join(" "));
      });
      console.log("HERO HEADING", locale.lang, `${width}x900`, lines);
      expect(lines).toHaveLength(2);
      if (locale.lang === "vi") expect(lines).toEqual(["Đội nhân viên AI", "của riêng bạn"]);
    });
  }

  test(`${locale.lang}: desktop SPEC dimensions at 1440px`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(locale.path);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.locator(".hero .wrap").evaluate(el =>
      getComputedStyle(el).gridTemplateColumns.split(" ")[0],
    )).toBe("600px");
    await expect(page.locator(".hero .ctas")).toHaveCSS("max-width", "600px");
    await expect(page.locator(".sscard code")).toHaveCSS("border-radius", "8px");
    await expect(page.locator(".final")).toHaveCSS("padding-top", "112px");
    await expect(page.locator(".final")).toHaveCSS("padding-bottom", "112px");
  });

  test(`${locale.lang}: mobile SPEC dimensions at 390x844`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(locale.path);
    await page.evaluate(() => document.fonts.ready);
    for (const [selector, size] of [
      [".feat h3", "18px"], [".hero .eyebrow", "13px"],
      [".mate .tag", "13px"], [".mate h3", "16px"],
      [".hero .meta", "14px"], [".hero .msi", "14px"],
      [".hero .ss", "14px"], [".dl .btn small", "12px"],
    ]) {
      for (const element of await page.locator(selector).all()) {
        await expect(element).toHaveCSS("font-size", size);
      }
    }
    await expect(page.locator(".hero .ctas")).toHaveCSS("max-width", "600px");
    await expect(page.locator(".hero .ss")).toHaveCSS("padding", "12px 14px");
    await expect(page.locator(".sscard code")).toHaveCSS("border-radius", "8px");
    await expect(page.locator(".final")).toHaveCSS("padding-top", "72px");
    await expect(page.locator(".final")).toHaveCSS("padding-bottom", "72px");
    expect(await page.locator(".stage").evaluate(el => el.getBoundingClientRect().height)).toBe(168);
    await expect(page.locator(".stage-in")).toHaveCSS("transform", "matrix(0.3, 0, 0, 0.3, 0, 0)");
    await expect(page.locator(".stage-in")).toHaveCSS("top", "-4px");
    await expect(page.locator(".marq")).toHaveCSS("overflow", "hidden");
    await expect(page.locator(".marq .row")).toHaveCSS("gap", "16px");
    await expect(page.locator(".marq .row")).toHaveCSS("animation-name", "none");
    expect(await page.locator(".marq img").first().evaluate(el =>
      el.getBoundingClientRect().width,
    )).toBe(40);
    await expect(page.locator(".lineup")).toHaveCSS("gap", "12px");
    await expect(page.locator(".lineup")).toHaveCSS("flex-wrap", "nowrap");
    await page.locator(".lineup").scrollIntoViewIfNeeded();
    const images = page.locator(".lineup img");
    await expect(images).toHaveCount(8);
    for (const [index, img] of (await images.all()).entries()) {
      if (index < 3) {
        await expect(img).toBeVisible();
        expect(await img.evaluate(el => el.getBoundingClientRect().width)).toBe(56);
        await expect.poll(() => img.evaluate(el =>
          el instanceof HTMLImageElement && el.currentSrc.endsWith("lookup-128.webp"),
        )).toBe(true);
      } else {
        await expect(img).toHaveCSS("display", "none");
      }
    }
    await expect(page.locator(".lineup img:visible")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.emulateMedia({ colorScheme: "dark" });
    for (const small of await page.locator(".dl .btn small").all()) {
      await expect(small).toHaveCSS("font-size", "12px");
    }
  });

  test(`${locale.lang}: mobile hero stage and actions fit at 390x844`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(locale.path);
    await page.evaluate(() => document.fonts.ready);
    const stage = await page.locator(".hero .stage").boundingBox();
    expect(stage).not.toBeNull();
    expect(stage?.height).toBe(168);
    const boxes = [];
    for (const selector of [".hero .ss", ".hero .ctas .btn-win", ".hero .ctas .btn-web"]) {
      const box = await page.locator(selector).boundingBox();
      if (!box) throw new Error(`Missing ${selector}`);
      boxes.push({ selector, ...box });
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    console.log("MOBILE HERO", locale.lang, { stageHeight: stage?.height, boxes });
  });

  test(`${locale.lang}: mascot WebP images stay within the full-page image budget`, async ({ page }) => {
    const transfers: Promise<number>[] = [];
    page.on("response", response => {
      if (response.request().resourceType() !== "image") return;
      transfers.push((async () => {
        expect(response.ok(), response.url()).toBe(true);
        expect(await response.finished()).toBeNull();
        const sizes = await response.request().sizes();
        return sizes.responseBodySize + sizes.responseHeadersSize;
      })());
    });
    await page.goto(locale.path);
    // Visit each viewport so native lazy loading also fetches the lower sections.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight) {
        window.scrollTo(0, y);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
    const mascots = page.locator('img[src*="/landing/img/mascots/"]');
    expect(await mascots.count()).toBeGreaterThan(0);
    for (const mascot of await mascots.all()) {
      const source = mascot.locator('..').locator('source[type="image/webp"]:not([media])');
      await expect(source).toHaveCount(1);
      const fallback = await mascot.getAttribute("src");
      expect(fallback).not.toBeNull();
      if (!fallback) throw new Error("Missing mascot PNG fallback");
      const uses300 = await mascot.evaluate(img => img.matches('.hero .m[style*="width:150px"] img, img.tm'));
      const webp = fallback.replace(/\.png$/, ".webp");
      await expect(source).toHaveAttribute("srcset", uses300 ? webp.replace(/-256\.webp$/, "-300.webp") : webp);
      await expect(mascot).toHaveAttribute("width", /^[1-9]\d*$/);
      await expect(mascot).toHaveAttribute("height", /^[1-9]\d*$/);
      await expect.poll(() => mascot.evaluate(img =>
        img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
          && img.currentSrc.endsWith(".webp"),
      )).toBe(true);
    }
    await page.waitForLoadState("networkidle");
    const bytes = (await Promise.all(transfers)).reduce((sum, size) => sum + size, 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1_500_000);
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
    test(`${locale.lang}: Windows download labels stay bold and on one line at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(locale.path);
      await page.evaluate(() => document.fonts.ready);
      const buttons = page.locator(".btn-win");
      await expect(buttons).toHaveCount(3);
      for (const button of await buttons.all()) {
        const label = button.locator(".lbl");
        expect(await label.evaluate(el => el.firstChild?.textContent)).toBe(
          locale.lang === "en" ? "Download for Windows" : "Tải cho Windows",
        );
        for (const element of [button, label]) {
          await expect(element).toHaveCSS("font-size", "19px");
          await expect(element).toHaveCSS("font-weight", "700");
        }
        const layout = await label.evaluate(el => {
          if (!el.firstChild) throw new Error("Missing Windows download label");
          const range = document.createRange();
          range.selectNode(el.firstChild);
          return { lines: range.getClientRects().length, fits: el.scrollWidth <= el.clientWidth };
        });
        expect(layout.lines).toBe(1);
        expect(layout.fits).toBe(true);
        expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    });

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

  test(`${locale.lang}: compact copy and commands fit at 390px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(locale.path);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".faq details").evaluateAll(items => {
      for (const item of items) item.setAttribute("open", "");
    });
    const command = page.locator(".faq details").nth(3).locator("pre > code");
    await expect(command).toHaveText("Get-FileHash .\\VNBot-Setup-0.3.7-x64.exe -Algorithm SHA256");
    await expect(command).toBeVisible();
    const overflow = await page.locator("body *").evaluateAll(elements => elements
      .filter(el => !el.closest(".marq") && el.getClientRects().length
        && el.getBoundingClientRect().right > window.innerWidth)
      .map(el => ({ tag: el.tagName, className: el.className })));
    expect(overflow).toEqual([]);
    for (const label of await page.locator(".eyebrow").all()) {
      const lines = await label.evaluate(el => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size;
      });
      expect(lines).toBe(1);
    }
    for (const label of await page.locator(".hero .btn .lbl").all()) {
      await expect(label).toHaveCSS("font-size", "19px");
      await expect(label).toHaveCSS("font-weight", "700");
    }
  });

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
    await expect(page.locator(".hero .meta")).toContainText("168 MB");
    await context.close();
  });
}

for (const locale of [{ path: "/", lang: "vi" }, { path: "/en/", lang: "en" }]) {
  test(`${locale.lang}: light hero CTA contrast meets WCAG AA`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(locale.path);
    const button = page.locator(".hero .btn-win");
    await expect(button).toHaveCSS("background-color", "rgb(15, 122, 68)");
    const { main, sub } = await button.evaluate(element => {
      const label = element.querySelector(".lbl");
      const small = element.querySelector("small");
      if (!label || !small) throw new Error("Missing hero CTA labels");
      const channels = (color: string) => {
        const values = color.match(/[\d.]+/g)?.map(Number);
        if (!values || values.length < 3) throw new Error(`Unsupported color: ${color}`);
        return values;
      };
      const background = channels(getComputedStyle(element).backgroundColor);
      const luminance = (rgb: number[]) => rgb.reduce((sum, channel, index) => {
        const value = channel / 255;
        const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index];
      }, 0);
      const contrast = (target: Element) => {
        const style = getComputedStyle(target);
        const foreground = channels(style.color);
        const alpha = (foreground[3] ?? 1) * Number(style.opacity);
        const composite = background.slice(0, 3).map((channel, index) =>
          foreground[index] * alpha + channel * (1 - alpha));
        const a = luminance(composite);
        const b = luminance(background.slice(0, 3));
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      return { main: contrast(label), sub: contrast(small) };
    });
    console.log("CONTRAST", locale.lang, main, sub);
    expect(main).toBeGreaterThanOrEqual(4.5);
    expect(sub).toBeGreaterThanOrEqual(4.5);
  });
}
