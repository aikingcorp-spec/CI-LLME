import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { builtinToolLabel } from "./builtin-tool-labels";

it("labels every built-in tool without exposing its id", () => {
  for (const name of BUILTIN_TOOL_NAMES) expect(builtinToolLabel(name)).not.toContain("_");
  expect(builtinToolLabel("computer_observe")).toBe("Computer observe");
});

it("humanizes an unknown tool id", () => {
  expect(builtinToolLabel("future_tool")).toBe("Future tool");
});
