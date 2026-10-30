import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("icon integrity checker", () => {
  it("accepts the generated approved set", () => {
    expect(() =>
      execFileSync("node", ["scripts/check-icons.mjs"], { encoding: "utf8" }),
    ).not.toThrow();
  });
});
