import { describe, expect, it } from "vitest";
import { stripOpenSource } from "./catalog-text";

describe("stripOpenSource", () => {
  it.each([
    ["An open-source tool for X", "A tool for X"],
    ["An open source alternative to Y", "An alternative to Y"],
    ["Acme is an open-source project management tool.", "Acme is a project management tool."],
    ["Open source CRM for teams.", "CRM for teams."],
    ["Great notes. Open-source editor for docs.", "Great notes. Editor for docs."],
    ["A free and open-source wiki", "A free wiki"],
    ["Open-source and free analytics", "Free analytics"],
    ["Fast (open source) editor", "Fast editor"],
    ["Uses open-source libraries, and more", "Uses libraries, and more"],
    ["The platform is open source.", "The platform."],
    ["Self-hosted, open-source, private", "Self-hosted, private"],
    ["OPEN SOURCE chat", "Chat"],
    ["Get Open Source Broker Setting", "Get Broker Setting"],
  ])("rewrites %j", (input, expected) => {
    expect(stripOpenSource(input)).toBe(expected);
  });

  it.each(["Send email from Gmail.", "Opens source files in the editor", "", "  keep  spacing  "])(
    "leaves %j unchanged",
    (input) => {
      expect(stripOpenSource(input)).toBe(input);
    },
  );

  it("never leaves the phrase behind", () => {
    const messy = "Open Source, open-source and OpenSource tools (open source) are open sourced.";
    expect(stripOpenSource(messy)).not.toMatch(/open[\s-]?source/i);
  });
});
