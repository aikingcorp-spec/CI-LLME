import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NATIVE_DESKTOP_APP_ID } from "./native-postgres-layout.js";
import { NATIVE_BUNDLE_RESOURCE } from "./native-stack.js";

type BuilderTarget = string | { target?: string; arch?: string };

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  version?: string;
  productName?: string;
  scripts?: Record<string, string>;
  build?: {
    productName?: string;
    appId?: string;
    linux?: { executableName?: string; target?: BuilderTarget[] };
    deb?: { depends?: string[] };
    win?: { target?: BuilderTarget[]; verifyUpdateCodeSignature?: boolean };
    extraResources?: { from: string; to: string }[];
    publish?: { provider?: string; url?: string; owner?: string; repo?: string }[];
    mac?: {
      target?: BuilderTarget[];
      extendInfo?: Record<string, string>;
      extraResources?: { from: string; to: string }[];
    };
  };
};

function targetNames(targets: BuilderTarget[] | undefined) {
  return (targets ?? []).map((target) => (typeof target === "string" ? target : target.target));
}

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.version).toBe("0.4.1");
    expect(packageJson.productName).toBe("VNBot");
    expect(packageJson.scripts?.["build:native"]).toBe("node scripts/build-native.mjs");
    expect(targetNames(packageJson.build?.win?.target)).toEqual(["nsis", "msi"]);
    expect(packageJson.build?.win?.verifyUpdateCodeSignature).toBe(true);
    expect(targetNames(packageJson.build?.linux?.target)).toEqual(["AppImage", "deb"]);
    expect(targetNames(packageJson.build?.mac?.target)).toEqual(["dmg", "zip"]);
    expect(packageJson.build?.productName).toBeUndefined();
    expect(packageJson.build?.appId).toBe(NATIVE_DESKTOP_APP_ID);
    expect(packageJson.build?.linux?.executableName).toBe("vnbot");
    expect(packageJson.build?.deb?.depends).toContain("libasound2t64 | libasound2");
    expect(packageJson.build?.deb?.depends).toEqual(
      expect.arrayContaining([
        "libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libxss1",
        "libxtst6",
        "xdg-utils",
        "libatspi2.0-0",
        "libuuid1",
        "libsecret-1-0",
      ]),
    );
    expect(packageJson.build?.publish).toEqual([
      { provider: "generic", url: "https://dl.vnbot.run/desktop/" },
    ]);
    expect(packageJson.build?.extraResources).toContainEqual(NATIVE_BUNDLE_RESOURCE);
    const prompts = Object.values(packageJson.build?.mac?.extendInfo ?? {}).join("\n");
    expect(prompts).toContain("VNBot");
    expect(prompts).not.toContain("Rakazo");
  });

  it.each(["es", "pl"])("ships a %s version of every macOS permission prompt", (locale) => {
    const strings = readFileSync(
      path.resolve(import.meta.dirname, `../assets/${locale}.lproj/InfoPlist.strings`),
      "utf8",
    );
    const prompts = Object.keys(packageJson.build?.mac?.extendInfo ?? {}).filter((key) =>
      key.endsWith("UsageDescription"),
    );
    expect(prompts.length).toBeGreaterThan(0);
    for (const key of prompts) expect(strings, key).toMatch(new RegExp(`^"${key}" = ".+";$`, "m"));
    expect(packageJson.build?.mac?.extraResources).toContainEqual({
      from: `assets/${locale}.lproj`,
      to: `${locale}.lproj`,
    });
  });
});
