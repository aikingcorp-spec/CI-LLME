import { expect, it } from "vitest";
import { catalogDescription, isForeignProductName, stripOpenSource } from "./catalog-text";

it.each(["Grok Build", "Grok", "Rakazo", "Cursor"])(
  "removes %s and open-source claims from catalog prose",
  (name) => {
    expect(catalogDescription(`A ${name} tool (open-source).`)).toBe("A tool.");
    expect(catalogDescription(`An open-source tool for ${name}'s tasks`)).toBe("A tool for tasks");
  },
);

it("keeps ordinary words, substrings, and other brands", () => {
  expect(catalogDescription("Move the cursor in Cursorless with GitHub.")).toBe(
    "Move the cursor in Cursorless with GitHub.",
  );
  expect(stripOpenSource("An open-source assistant")).toBe("An assistant");
});

it("flags catalog entries named after another product but not ordinary words", () => {
  expect(isForeignProductName("Grok Voice")).toBe(true);
  expect(isForeignProductName("Cursor Rules")).toBe(true);
  expect(isForeignProductName("Rakazo")).toBe(true);
  expect(isForeignProductName("cursor movement")).toBe(false);
  expect(isForeignProductName("Cursorless")).toBe(false);
  expect(isForeignProductName("GitHub")).toBe(false);
});
