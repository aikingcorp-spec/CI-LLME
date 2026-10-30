import { describe, expect, it } from "vitest";
import {
  EXCLUDED_CATALOG_CONTENT,
  findBannedBrandTerms,
  isExcludedCatalogText,
} from "./banned-brand.js";

it.each(["xAI", "Xai", "cursor.COM", "VNBOT VOICE", "vnbot SDK"])("bans %s", (term) => {
  expect(findBannedBrandTerms(term)).toEqual([term]);
  expect(EXCLUDED_CATALOG_CONTENT.test(term)).toBe(true);
});

it("does not confuse the ordinary text cursor with a domain", () => {
  expect(findBannedBrandTerms("Move the cursor.")).toEqual([]);
});

it("allows exact provider metadata only in the model-provider list", () => {
  expect(findBannedBrandTerms("xAI")).toEqual(["xAI"]);
  expect(findBannedBrandTerms("xAI", { modelProviderList: true })).toEqual([]);
  expect(findBannedBrandTerms("https://docs.x.ai/docs", { modelProviderList: true })).toEqual([]);
  expect(findBannedBrandTerms("https://docs.x.ai/docs")).toEqual(["docs.x.ai"]);
  expect(
    findBannedBrandTerms("https://docs.x.ai.evil.test/docs", { modelProviderList: true }),
  ).not.toEqual([]);
});

describe("isExcludedCatalogText", () => {
  it("judges URLs by host and owner, text by whole word", () => {
    expect(isExcludedCatalogText("https://github.com/getsentry/plugin-grok.git")).toBe(false);
    expect(isExcludedCatalogText("Grok Voice")).toBe(true);
    expect(isExcludedCatalogText("https://cursor.com/a")).toBe(true);
    expect(isExcludedCatalogText("https://github.com/xai-org/x")).toBe(true);
    expect(isExcludedCatalogText("xAI")).toBe(true);
    expect(isExcludedCatalogText("VNBot SDK")).toBe(true);
    expect(isExcludedCatalogText("VNBot Voice")).toBe(true);
  });
});

describe("EXCLUDED_CATALOG_CONTENT word and host boundaries", () => {
  it.each([
    "Grok Voice",
    "Plaid for xAI",
    "https://github.com/xai-org/plugin-marketplace",
    "see https://docs.x.ai/api",
    "x.ai",
    "https://api.cursor.com/v1",
    "cursor.com/agents",
    "VNBot SDK",
    "Skills for building on the VNBot Origin API",
  ])("excludes %s", (text) => expect(EXCLUDED_CATALOG_CONTENT.test(text)).toBe(true));
  it.each([
    "Taxaid invoices",
    "grokking algorithms",
    "https://max.ai/docs",
    "https://cursor.company.io",
    "precursor.com.example",
    "mycursor.com",
  ])("keeps %s", (text) => expect(EXCLUDED_CATALOG_CONTENT.test(text)).toBe(false));
});

it.each([
  "https://max.ai/docs",
  "https://cursor.company/docs",
  "https://github.com/example/xai-tools",
  "https://github.com/xai-org-tools/plugin",
  "https://github.com/example/cursor-sdk",
])("keeps exact URL boundaries: %s", (url) => {
  expect(isExcludedCatalogText(url)).toBe(false);
});
it.each([
  "https://github.com/cursor/plugins",
  "https://raw.githubusercontent.com/xai-org/plugins/main/index.json",
  "https://api.github.com/repos/elie222/example",
  "https://ghcr.io/cursor/tool",
])("blocks exact owners: %s", (url) => {
  expect(isExcludedCatalogText(url)).toBe(true);
});

it.each([
  "Taxaid invoices",
  "grokking algorithms",
  "https://max.ai/docs",
  "https://mycursor.com/a",
])("lint terms are anchored to whole words and hosts: keeps %s", (text) =>
  expect(findBannedBrandTerms(text)).toEqual([]),
);
it.each([
  ["Plaid for xAI", "xAI"],
  ["see https://api.cursor.com/v1", "api.cursor.com"],
  ["Grok Voice", "Grok"],
])("lint terms still find %s", (text, term) => expect(findBannedBrandTerms(text)).toEqual([term]));
