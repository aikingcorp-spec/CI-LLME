const OPEN_SOURCE = String.raw`open[\s-]?source(?:d)?`;
// Marks a spot where a sentence now starts, so the next letter can be capitalized.
const SENTENCE_START = "\u0000";

function removed(_match: string, offset: number, whole: string): string {
  return offset === 0 || /[.!?]\s*$/.test(whole.slice(0, offset)) ? SENTENCE_START : "";
}

/** Drops "open source" from third-party catalog copy so the site never shows it. */
export function stripOpenSource(text: string): string {
  if (!new RegExp(`\\b${OPEN_SOURCE}\\b`, "iu").test(text)) return text;
  return (
    text
      // "an open-source tool" -> "a tool"; pick a/an from the word that follows.
      .replace(
        new RegExp(`\\b(an?)\\s+${OPEN_SOURCE}\\s+(\\p{L})`, "giu"),
        (_match, article: string, letter: string) => {
          const chosen = /^[aeiou]/i.test(letter) ? "an" : "a";
          const cased =
            article.charAt(0) === article.charAt(0).toUpperCase()
              ? `${chosen.charAt(0).toUpperCase()}${chosen.slice(1)}`
              : chosen;
          return `${cased} ${letter}`;
        },
      )
      .replace(new RegExp(`\\(\\s*${OPEN_SOURCE}\\s*\\)`, "giu"), "")
      // "free and open source" -> "free"; "open source and free" -> "free".
      .replace(new RegExp(`\\s+(?:and|&|or)\\s+${OPEN_SOURCE}\\b`, "giu"), "")
      .replace(new RegExp(`\\b${OPEN_SOURCE}\\s+(?:and|&|or)\\s+`, "giu"), removed)
      .replace(new RegExp(`\\b${OPEN_SOURCE}\\b\\s*`, "giu"), removed)
      // "The platform is open source." -> "The platform."
      .replace(/\s+(?:is|are|and|or|with)\s*(?=[.,;:!?]|$)/giu, "")
      .replace(/\s+([,.;:!?)])/gu, "$1")
      .replace(/\(\s+/gu, "(")
      .replace(/,(?:\s*,)+/gu, ",")
      .replace(/\s{2,}/gu, " ")
      .replace(new RegExp(`${SENTENCE_START}(\\p{L})`, "gu"), (_match, letter: string) =>
        letter.toUpperCase(),
      )
      .replaceAll(SENTENCE_START, "")
      .trim()
  );
}

/** Remove product names in third-party prose; lowercase cursor remains an ordinary word. */
export function catalogDescription(text: string): string {
  return stripOpenSource(text)
    .replace(/\b(?:Grok Build|Grok|Rakazo|Cursor)(?:['’]s)?\b/gu, "")
    .replace(/\(\s*\)/gu, "")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/,(?:\s*,)+/gu, ",")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/** True when a third-party catalog entry is named after another product, so the list can hide it. */
export function isForeignProductName(text: string): boolean {
  return /\b(?:Grok(?: Build)?|Rakazo|Cursor)\b/u.test(text);
}
