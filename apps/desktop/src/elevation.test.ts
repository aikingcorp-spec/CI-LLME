import { describe, expect, it } from "vitest";
import { isElevatedProcess } from "./elevation.js";

const medium = "Mandatory Label\\Medium Mandatory Level  Label  S-1-16-8192";
const high = "Mandatory Label\\High Mandatory Level    Label  S-1-16-12288";

describe("isElevatedProcess", () => {
  it("is true for root on Linux and macOS", () => {
    expect(isElevatedProcess({ platform: "linux", getuid: () => 0 })).toBe(true);
    expect(isElevatedProcess({ platform: "darwin", getuid: () => 0 })).toBe(true);
  });

  it("is false for an ordinary user on Linux and macOS", () => {
    expect(isElevatedProcess({ platform: "linux", getuid: () => 1000 })).toBe(false);
    expect(isElevatedProcess({ platform: "darwin", getuid: () => 501 })).toBe(false);
    expect(isElevatedProcess({ platform: "linux" })).toBe(false);
  });

  it("is true for a Windows token at high integrity, false at medium", () => {
    expect(isElevatedProcess({ platform: "win32", whoamiGroups: () => high })).toBe(true);
    expect(isElevatedProcess({ platform: "win32", whoamiGroups: () => medium })).toBe(false);
  });

  it("does not treat an administrator account with a filtered token as elevated", () => {
    const groups = `BUILTIN\\Administrators  Alias  S-1-5-32-544  Group used for deny only\n${medium}`;
    expect(isElevatedProcess({ platform: "win32", whoamiGroups: () => groups })).toBe(false);
  });

  it("answers false when the Windows probe fails or is missing", () => {
    expect(
      isElevatedProcess({
        platform: "win32",
        whoamiGroups: () => {
          throw new Error("spawn whoami ENOENT");
        },
      }),
    ).toBe(false);
    expect(isElevatedProcess({ platform: "win32" })).toBe(false);
  });
});
