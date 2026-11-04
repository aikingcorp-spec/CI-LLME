import { describe, expect, it } from "vitest";
import { chooseRuntime } from "./stack-runtime.js";

describe("chooseRuntime", () => {
  it("uses native on Linux and Windows", () => {
    expect(chooseRuntime({ platform: "linux" })).toBe("native");
    expect(chooseRuntime({ platform: "win32" })).toBe("native");
  });
  it("uses native on macOS and preserves explicit Docker opt-in", () => {
    expect(chooseRuntime({ platform: "darwin" })).toBe("native");
    expect(chooseRuntime({ platform: "darwin", env: { RAKAZO_DESKTOP_RUNTIME: "docker" } })).toBe(
      "docker",
    );
    expect(chooseRuntime({ platform: "darwin", env: { RAKAZO_DESKTOP_RUNTIME: "native" } })).toBe(
      "native",
    );
  });
});
