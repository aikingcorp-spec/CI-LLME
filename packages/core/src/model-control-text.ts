// Some models (gpt-oss through OpenAI-compatible proxies) leak their chat-format control tokens
// and their own retry talk into the reply when a tool call fails to parse. Neither is for the user.

const CONTROL_TOKEN = /<\|(?:start|end|message|channel|constrain|call|return|im_start|im_end)\|>/iu;
const CONTROL_TOKENS =
  /<\|(?:start|end|message|channel|constrain|call|return|im_start|im_end)\|>/giu;
// "assistant<|channel|>commentary to=functions.web_search <|constrain|>json" and the like.
const TOOL_HEADER =
  /\b(?:assistant\s*)?(?:(?:analysis|commentary|final)\s+)?to=functions\.[\w.-]+(?:\s*<\|constrain\|>)?(?:\s*(?:json|code)\b)?/giu;
const TOOL_HEADER_TEST = /\bto=functions\.[\w.-]+/iu;
// The model talking to itself about a failed tool call, not to the user.
const SELF_TALK =
  /\b(?:the\s+)?tool\s+(?:invocation|call)s?\s+(?:had|has|have|returned)\s+(?:a\s+)?(?:syntax\s+)?errors?\b|\b(?:we|i)\s+(?:need|must|should)\s+(?:to\s+)?(?:construct|provide|format|pass|call|escape)\b[^.\n]{0,40}\b(?:json|tool|arguments?)\b/iu;

/** The Vietnamese status line shown instead of the model's tool-call retry talk. */
export const TOOL_CALL_RETRY_LINE_VI = "Không gọi được công cụ, đang thử lại…";

/** Whether the text is chat-format control output or the model's own tool-call retry talk. */
export function isModelControlText(text: string): boolean {
  return CONTROL_TOKEN.test(text) || TOOL_HEADER_TEST.test(text) || SELF_TALK.test(text);
}

// Where leaked output starts inside a longer reply; the live filter ends the reply there.
const LEAK_START = /<\||\bto=functions\./u;
const LEAK_LEAD_IN = /\b(?:assistant\s*)?(?:(?:analysis|commentary|final)\s*)?$/iu;
// The live filter judges a message by its opening this long.
const JUDGED_OPENING_CHARS = 160;

/**
 * Cleans one stored assistant reply the way the live filter would have: a reply that opens with
 * control output or retry talk is empty, and a leak later on ends the reply there.
 */
export function sanitizeStoredAssistantText(text: string): string {
  const [before = ""] = text.split(LEAK_START);
  // "assistant" or "commentary" right before the first token belongs to the leak.
  const kept = before.replace(LEAK_LEAD_IN, "");
  if (isModelControlText(kept.slice(0, JUDGED_OPENING_CHARS))) return "";
  return before === text ? text : stripModelControlTokens(kept).trimEnd();
}

/**
 * Cleans leaked control output out of stored bot messages as they are read. Text blocks that
 * were entirely leaked are dropped. User and system messages, and clean text, come back as stored.
 */
export function sanitizeStoredBlocks<T extends { kind: string }>(role: string, blocks: T[]): T[] {
  if (role !== "bot") return blocks;
  let changed = false;
  const clean = blocks.flatMap((block) => {
    if (block.kind !== "text" || !("text" in block) || typeof block.text !== "string") {
      return [block];
    }
    const text = sanitizeStoredAssistantText(block.text);
    if (text === block.text) return [block];
    changed = true;
    return text.trim() ? [{ ...block, text }] : [];
  });
  return changed ? clean : blocks;
}

/** Removes leaked control tokens and tool-call headers, keeping any real text around them. */
export function stripModelControlTokens(text: string): string {
  return text
    .replace(TOOL_HEADER, "")
    .replace(CONTROL_TOKENS, "")
    .replace(/[ \t]{2,}/gu, " ");
}
