import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStagingDistribution,
  desktopBuildDefines,
  isStagingDistribution,
  PRODUCTION_PORTAL_ORIGIN,
  readPublicPin,
  resolvePublicDistribution,
  STAGING_USER_DATA_NAME,
  stagingUserDataDir,
} from "./public-distribution.js";

const pin = {
  issuer: "https://stage.example.test",
  audience: "vnbot-native",
  publicKey: "pin-public-material",
  centralAuthUrl: "https://stage.example.test/api/auth",
  centralOrigin: "https://stage.example.test",
};

describe("public distribution", () => {
  it("inlines only the public pin and leaves the production portal when no origin is set", () => {
    expect(resolvePublicDistribution({})).toEqual({ identityPin: "", portalOrigin: "" });
    const baked = resolvePublicDistribution({ RAKAZO_IDENTITY_PIN: JSON.stringify(pin) });
    expect(JSON.parse(baked.identityPin)).toEqual(pin);
    expect(baked.portalOrigin).toBe(pin.centralOrigin);
    expect(baked.identityPin).not.toContain("deviceId");
    expect(baked.identityPin).not.toContain("privateKey");
  });

  it("rejects private material, device ids, and a portal that disagrees with the pin", () => {
    expect(() => readPublicPin(JSON.stringify({ ...pin, deviceId: "chosen" }))).toThrow(
      "Invalid identity exchange configuration",
    );
    expect(() => readPublicPin(JSON.stringify({ ...pin, privateKey: "secret" }))).toThrow(
      "Invalid identity exchange configuration",
    );
    expect(() => readPublicPin(JSON.stringify({ ...pin, devicePrivateKey: "secret" }))).toThrow(
      "Invalid identity exchange configuration",
    );
    expect(() =>
      readPublicPin(JSON.stringify({ ...pin, allowlist: ["person@example.test"] })),
    ).toThrow("Invalid identity exchange configuration");
    expect(() =>
      resolvePublicDistribution({
        RAKAZO_IDENTITY_PIN: JSON.stringify(pin),
        RAKAZO_CLOUD_URL: "https://other.example.test",
      }),
    ).toThrow("Public portal origin must match the issuer pin.");
  });

  it("requires a non-production pin and portal before a staging installer", () => {
    expect(() => assertStagingDistribution({})).toThrow("RAKAZO_IDENTITY_PIN");
    expect(() => assertStagingDistribution({ RAKAZO_IDENTITY_PIN: JSON.stringify(pin) })).toThrow(
      "RAKAZO_CLOUD_URL",
    );
    expect(() =>
      assertStagingDistribution({
        RAKAZO_IDENTITY_PIN: JSON.stringify({
          ...pin,
          issuer: "https://app.vnbot.run",
          centralAuthUrl: "https://app.vnbot.run/api/auth",
          centralOrigin: "https://app.vnbot.run",
        }),
        RAKAZO_CLOUD_URL: "https://app.vnbot.run",
      }),
    ).toThrow("production portal or update feed");
    const accepted = assertStagingDistribution({
      RAKAZO_IDENTITY_PIN: JSON.stringify(pin),
      RAKAZO_CLOUD_URL: pin.centralOrigin,
    });
    expect(accepted.portalOrigin).toBe("https://stage.example.test");
    expect(JSON.parse(accepted.identityPin)).toEqual(pin);
  });

  it("defines the bundled pin and portal as strings the desktop build can inline", () => {
    expect(desktopBuildDefines({})).toEqual({
      "process.env.RAKAZO_IDENTITY_PIN": '""',
      "process.env.RAKAZO_CLOUD_URL": '""',
    });
    const defines = desktopBuildDefines({
      RAKAZO_IDENTITY_PIN: JSON.stringify(pin),
      RAKAZO_CLOUD_URL: pin.centralOrigin,
    });
    expect(JSON.parse(JSON.parse(defines["process.env.RAKAZO_IDENTITY_PIN"]))).toEqual(pin);
    expect(JSON.parse(defines["process.env.RAKAZO_CLOUD_URL"])).toBe(pin.centralOrigin);
  });

  it("isolates userData into VNBot-Staging only when pinned or pointed to a non-production host", () => {
    expect(isStagingDistribution({})).toBe(false);
    expect(isStagingDistribution({ RAKAZO_CLOUD_URL: PRODUCTION_PORTAL_ORIGIN })).toBe(false);
    expect(
      isStagingDistribution({
        RAKAZO_IDENTITY_PIN: JSON.stringify({
          ...pin,
          issuer: PRODUCTION_PORTAL_ORIGIN,
          centralAuthUrl: `${PRODUCTION_PORTAL_ORIGIN}/api/auth`,
          centralOrigin: PRODUCTION_PORTAL_ORIGIN,
        }),
        RAKAZO_CLOUD_URL: PRODUCTION_PORTAL_ORIGIN,
      }),
    ).toBe(false);
    expect(stagingUserDataDir({}, "/home/u/.config", path.join)).toBeNull();
    expect(
      stagingUserDataDir(
        { RAKAZO_CLOUD_URL: "https://stg-cff7d884.vnbot.run" },
        "/home/u/.config",
        path.join,
      ),
    ).toBe(path.join("/home/u/.config", STAGING_USER_DATA_NAME));
    expect(
      stagingUserDataDir(
        { RAKAZO_IDENTITY_PIN: JSON.stringify(pin) },
        "/home/u/.config",
        path.join,
      ),
    ).toBe(path.join("/home/u/.config", STAGING_USER_DATA_NAME));
  });
});
