import type { WebFetchResult } from "@rakazo/adapter-kit";
import { normalizedHttpUrl } from "@rakazo/core/egress";
import { VNBOT_HELP_INDEX_URL } from "./platform-identity.js";

const OFFICIAL_INDEX = normalizedHttpUrl(VNBOT_HELP_INDEX_URL);
const OFFICIAL_ORIGIN = OFFICIAL_INDEX ? new URL(OFFICIAL_INDEX).origin : undefined;

const CHAPTER_PATH = /^\/help\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const MARKUP_TAIL = /[)\]}.,;:!?]+$/u;

/**
 * Canonical chapter URL printed by the official index, or undefined.
 * The slug comes from the fetched index. This file does not list chapters.
 */
export function canonicalGuideChapterUrl(raw: string): string | undefined {
  if (!OFFICIAL_INDEX || !OFFICIAL_ORIGIN) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.origin !== OFFICIAL_ORIGIN) return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  const slug = CHAPTER_PATH.exec(url.pathname)?.[1];
  if (!slug) return undefined;
  return `${OFFICIAL_ORIGIN}/help/${slug}.md`;
}

/** Chapter URLs present in index text. Other links in that text are ignored. */
export function guideChapterUrlsInText(text: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https:\/\/[^\s<>"'`]+/g)) {
    const chapter = canonicalGuideChapterUrl(match[0].replace(MARKUP_TAIL, ""));
    if (!chapter || seen.has(chapter)) continue;
    seen.add(chapter);
    found.push(chapter);
  }
  return found;
}

function isFetchedPage(result: unknown): result is WebFetchResult {
  if (typeof result !== "object" || result === null || "error" in result) return false;
  if (!("url" in result) || typeof result.url !== "string") return false;
  if (!("title" in result) || typeof result.title !== "string") return false;
  if (!("text" in result) || typeof result.text !== "string") return false;
  return "truncated" in result && typeof result.truncated === "boolean";
}

/**
 * Chapters a later readonly web_fetch may open without a new site prompt.
 * Only a successful fetch whose final URL is still the official index qualifies.
 * A redirect, an error, or any other page contributes nothing.
 */
export function guideChaptersFromIndexFetch(input: {
  requestedUrl: string;
  result: unknown;
}): readonly string[] {
  if (!OFFICIAL_INDEX) return [];
  if (normalizedHttpUrl(input.requestedUrl) !== OFFICIAL_INDEX) return [];
  if (!isFetchedPage(input.result)) return [];
  if (normalizedHttpUrl(input.result.url) !== OFFICIAL_INDEX) return [];
  return guideChapterUrlsInText(input.result.text);
}
