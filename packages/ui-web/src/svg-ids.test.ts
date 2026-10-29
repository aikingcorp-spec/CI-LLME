import { describe, expect, it } from "vitest";
import { prefixSvgIds } from "./svg-ids.js";

describe("prefixSvgIds", () => {
  it("prefixes ids, references, and pattern urls without leaving a shared id", () => {
    const svg = `<svg><symbol id="eye"></symbol><path id="gingham" fill="url(#gingham)"/><use href="#eye" xlink:href="#eye"/></svg>`;
    const first = prefixSvgIds(svg, ":r1:");
    const second = prefixSvgIds(svg, "r2");
    expect(first).toContain('id="r1-eye"');
    expect(first).toContain('href="#r1-eye"');
    expect(first).toContain('xlink:href="#r1-eye"');
    expect(first).toContain("url(#r1-gingham)");
    expect(first).not.toMatch(/ id="eye"/);
    expect(first).not.toContain('href="#eye"');
    expect(second).toContain('id="r2-eye"');
    expect(first).not.toBe(second);
  });
});
