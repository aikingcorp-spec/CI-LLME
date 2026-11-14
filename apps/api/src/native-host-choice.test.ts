import { describe, expect, it } from "vitest";
import { hostComputerAvailability } from "./routes/shared.js";

const token = "ab".repeat(32);

describe("native host choice", () => {
  it("offers the choice only for docker or a configured native bridge", () => {
    expect(
      hostComputerAvailability({
        sandboxProvider: "docker",
        nativeHostBridge: false,
        desktopHostChoiceEnabled: true,
        storedHost: "docker",
      }),
    ).toEqual({
      canChooseHostComputer: true,
      computerHost: "docker",
      sandboxProvider: "docker",
    });
    expect(
      hostComputerAvailability({
        sandboxProvider: "none",
        nativeHostBridge: true,
        desktopHostChoiceEnabled: true,
        storedHost: null,
      }),
    ).toEqual({
      canChooseHostComputer: true,
      computerHost: null,
      sandboxProvider: "none",
    });
    expect(
      hostComputerAvailability({
        sandboxProvider: "none",
        nativeHostBridge: false,
        desktopHostChoiceEnabled: true,
        storedHost: "this-mac",
      }).canChooseHostComputer,
    ).toBe(false);
    expect(
      hostComputerAvailability({
        sandboxProvider: "e2b",
        nativeHostBridge: true,
        desktopHostChoiceEnabled: true,
        storedHost: "this-mac",
      }),
    ).toMatchObject({ canChooseHostComputer: false, sandboxProvider: "e2b", computerHost: null });
  });

  it("reports a granted native computer as the non-graphical desktop and hides the bridge secret", () => {
    const granted = hostComputerAvailability({
      sandboxProvider: "none",
      nativeHostBridge: true,
      desktopHostChoiceEnabled: true,
      storedHost: "this-mac",
    });
    expect(granted).toEqual({
      canChooseHostComputer: true,
      computerHost: "this-mac",
      sandboxProvider: "desktop",
    });
    expect(JSON.stringify(granted)).not.toContain(token);
    expect(
      hostComputerAvailability({
        sandboxProvider: "none",
        nativeHostBridge: true,
        desktopHostChoiceEnabled: true,
        storedHost: "docker",
      }),
    ).toEqual({
      canChooseHostComputer: true,
      computerHost: "docker",
      sandboxProvider: "none",
    });
    expect(
      hostComputerAvailability({
        sandboxProvider: "none",
        nativeHostBridge: true,
        desktopHostChoiceEnabled: false,
        storedHost: "this-mac",
      }).canChooseHostComputer,
    ).toBe(false);
  });
});
