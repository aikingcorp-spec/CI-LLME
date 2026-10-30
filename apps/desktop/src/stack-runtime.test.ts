import { describe, expect, it } from "vitest";
import { chooseRuntime } from "./stack-runtime.js";

describe("chooseRuntime", () => {
  it("uses native on Linux and Windows", () => {
    expect(chooseRuntime({ platform: "linux" })).toBe("native");
    expect(chooseRuntime({ platform: "win32" })).toBe("native");
  });
  it("uses Docker on macOS unless overridden", () => {
    expect(chooseRuntime({ platform: "darwin" })).toBe("docker");
    expect(chooseRuntime({ platform: "darwin", env: { RAKAZO_DESKTOP_RUNTIME: "native" } })).toBe(
      "native",
    );
  });
});
