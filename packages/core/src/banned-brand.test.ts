import { expect, it } from "vitest";
import { EXCLUDED_CATALOG_CONTENT, findBannedBrandTerms } from "./banned-brand.js";

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
