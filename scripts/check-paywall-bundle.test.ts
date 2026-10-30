import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDist, scanText } from "./check-paywall-bundle.ts";

describe("check-paywall-bundle", () => {
  it("flags Stripe SDK, checkout URLs and paywall copy", () => {
    const text = [
      'import("https://js.stripe.com/v3")',
      "loadStripe(key)",
      "`Add credits`",
      "`Connect your own API key in Models or choose VNBot credits in Billing.`",
      "`Subscribe in Billing to keep running bots.`",
    ].join(";");
    expect(scanText("a.js", text).length).toBeGreaterThanOrEqual(5);
  });

  it("ignores unrelated uses of the word stripe and free-model labels", () => {
    const text =
      "t.hasStripe=1;`stripe-size`;finance:[`stripe`,`brex`];[`__stripe`];billing:``;`Free`";
    expect(scanText("a.js", text)).toEqual([]);
  });

  it("scans nested assets in a dist directory", () => {
    const dist = mkdtempSync(join(tmpdir(), "paywall-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "index.js"), "x=`Manage billing`");
    writeFileSync(join(dist, "index.html"), "<html></html>");
    expect(scanDist(dist).map((f) => f.file)).toEqual([join("assets", "index.js")]);
  });
});
