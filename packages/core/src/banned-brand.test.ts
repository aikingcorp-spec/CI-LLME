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
