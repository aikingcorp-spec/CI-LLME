import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeWebUrlFile } from "./native-smoke.js";
import { configureUserDataName } from "./user-data-name.js";

describe("desktop user data name", () => {
  it.each([
    {
      platform: "win32",
      p: path.win32,
      appData: "C:\\Users\\a\\AppData\\Roaming",
      home: "C:\\Users\\a",
    },
    { platform: "linux", p: path.posix, appData: "/home/test/.config", home: "/home/test" },
  ])(
    "sets the name and agrees with native tooling on $platform",
    ({ platform, p, appData, home }) => {
      const env = platform === "win32" ? { APPDATA: appData } : {};
      const app = { setName: vi.fn(), getPath: vi.fn(() => appData), setPath: vi.fn() };
      configureUserDataName({ app, platform, pathModule: p });
      const root = p.join(appData, "VNBot");
      expect(app.setName).toHaveBeenCalledWith("VNBot");
      expect(app.setPath).toHaveBeenCalledWith("userData", root);
      expect(app.setName.mock.invocationCallOrder[0]).toBeLessThan(
        app.setPath.mock.invocationCallOrder[0]!,
      );
      expect(nativeWebUrlFile({ platform, pathModule: p, env, homedir: home })).toBe(
        p.join(root, "stack", ".desktop-web-url"),
      );
    },
  );

  it("preserves an explicit smoke or test profile", () => {
    const app = { setName: vi.fn(), getPath: vi.fn(() => "/config"), setPath: vi.fn() };
    configureUserDataName({
      app,
      platform: "linux",
      pathModule: path.posix,
      userDataDir: "/tmp/profile",
    });
    expect(app.setPath).toHaveBeenCalledWith("userData", "/tmp/profile");
  });
});
