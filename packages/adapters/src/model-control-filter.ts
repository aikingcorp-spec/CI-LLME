import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { isModelControlText, stripModelControlTokens, TOOL_CALL_RETRY_LINE_VI } from "@rakazo/core";

/** Text held per assistant message before it is judged; self-talk opens with its tell. */
const JUDGE_AFTER_CHARS = 160;
// How leaked output opens. Only an opening that could still become one of these is held, so a
// normal reply streams at once and a runtime that waits on a tool never waits on held text.
const LEAK_OPENINGS = [
  "<|",
  "assistant<|",
  "assistant to=",
  "the tool invocation",
  "the tool call",
  "tool invocation",
  "tool call",
  "we need to",
  "we must",
  "need proper json",
  "need closing",
  "it seems the tool",
  "it seems tool",
  "let's try again",
];
function mayOpenLeak(held: string): boolean {
  const text = held.trimStart().toLowerCase();
  if (!text) return true;
  return LEAK_OPENINGS.some((opening) => opening.startsWith(text) || text.startsWith(opening));
}

/**
 * Keeps leaked chat-format control tokens and the model's tool-call retry talk out of the reply.
 * Each assistant message's opening text is held until it can be judged: a leaked message is
 * dropped whole and shown once as a Vietnamese status line; a clean one streams on as written.
 */
export async function* filterModelControlText(
  events: AsyncIterable<AgentRuntimeEvent>,
): AsyncIterable<AgentRuntimeEvent> {
  let held = "";
  let judged = false;
  let dropping = false;
  let retryShown = false;
  const retryLine = (): AgentRuntimeEvent[] => {
    if (retryShown) return [];
    retryShown = true;
    return [{ type: "progress", text: TOOL_CALL_RETRY_LINE_VI, activity: true }];
  };
  // Releases the held opening of the message, or drops it when it is control output.
  const settle = (): AgentRuntimeEvent[] => {
    if (judged) return [];
    judged = true;
    const text = held;
    held = "";
    if (isModelControlText(text)) {
      dropping = true;
      return retryLine();
    }
    return text ? [{ type: "text", text }] : [];
  };
  try {
    for await (const event of events) {
      if (event.type === "text") {
        if (dropping) continue;
        if (!judged) {
          held += event.text;
          if (held.length >= JUDGE_AFTER_CHARS || !mayOpenLeak(held)) yield* settle();
          continue;
        }
        // Past the opening, a control token later in the message ends what is shown of it.
        if (isModelControlText(event.text)) {
          dropping = true;
          const kept = stripModelControlTokens(event.text.split(/<\||\bto=functions\./u)[0] ?? "");
          if (kept.trim()) yield { type: "text", text: kept };
          yield* retryLine();
          continue;
        }
        yield event;
        continue;
      }
      if (event.type === "thinking" || event.type === "usage" || event.type === "checkpoint") {
        yield event;
        continue;
      }
      yield* settle();
      if (event.type === "turn") {
        held = "";
        judged = false;
        dropping = false;
      }
      if (event.type === "done" && event.text) {
        const text = isModelControlText(event.text) ? "" : stripModelControlTokens(event.text);
        yield { type: "done", text };
        continue;
      }
      // A real tool run or reply clears the retry line, so the next failed call shows it again.
      if (event.type === "tool") retryShown = false;
      yield event;
    }
    yield* settle();
  } catch (error) {
    // A failed run still keeps the text the person saw; held text is released before it ends.
    yield* settle();
    throw error;
  }
}
