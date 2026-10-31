import { describe, expect, it, vi } from "vitest";
import { legacyProfilePath } from "./legacy-profile.js";

const fsCalls = vi.hoisted(() => ({
  access: vi.fn(async (_path: string) => {}),
  stat: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:fs/promises", () => fsCalls);

describe("legacy profile notice probe", () => {
  it.each([
    ["linux", "/home/test/.config", "/home/test/.config/Rakazo"],
    [
      "darwin",
      "/Users/test/Library/Application Support",
      "/Users/test/Library/Application Support/Rakazo",
    ],
    ["win32", "C:\\Users\\test\\AppData\\Roaming", "C:\\Users\\test\\AppData\\Roaming\\Rakazo"],
  ])("only checks existence of the old %s profile", async (platform, appDataDir, expected) => {
    vi.clearAllMocks();
    expect(await legacyProfilePath({ platform, appDataDir })).toBe(expected);
    expect(fsCalls.access).toHaveBeenCalledExactlyOnceWith(expected);
    for (const operation of [
      fsCalls.stat,
      fsCalls.open,
      fsCalls.readFile,
      fsCalls.writeFile,
      fsCalls.rename,
      fsCalls.rm,
    ])
      expect(operation).not.toHaveBeenCalled();
  });

  it("returns no notice when the old profile does not exist", async () => {
    vi.clearAllMocks();
    fsCalls.access.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await legacyProfilePath({ platform: "linux", appDataDir: "/config" })).toBeNull();
    expect(fsCalls.access).toHaveBeenCalledExactlyOnceWith("/config/Rakazo");
  });
});
