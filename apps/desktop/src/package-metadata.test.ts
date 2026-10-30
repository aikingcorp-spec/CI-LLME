import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  productName?: string;
  version?: string;
  build?: {
    productName?: string;
    publish?: { provider?: string; url?: string };
    win?: { verifyUpdateCodeSignature?: boolean };
  };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("VNBot");
    expect(packageJson.build?.productName).toBeUndefined();
  });

  it("declares the unsigned generic update feed for 0.3.6", () => {
    expect(packageJson.version).toBe("0.3.6");
    expect(packageJson.build?.publish).toEqual({
      provider: "generic",
      url: "https://dl.vnbot.run/desktop/",
    });
    expect(packageJson.build?.win?.verifyUpdateCodeSignature).toBe(false);
  });
});
