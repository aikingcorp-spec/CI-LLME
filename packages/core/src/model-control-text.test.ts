import { describe, expect, it } from "vitest";
import {
  isModelControlText,
  sanitizeStoredBlocks,
  stripModelControlTokens,
} from "./model-control-text.js";

describe("model control text", () => {
  it("recognizes leaked tokens, tool headers and retry talk", () => {
    expect(isModelControlText("Assistant<|channel|>commentary to=functions.web_search")).toBe(true);
    expect(isModelControlText("The tool invocation had syntax errors. Need proper JSON")).toBe(
      true,
    );
    expect(isModelControlText("We need to construct correct JSON for the tool")).toBe(true);
    expect(isModelControlText("Giá vàng hôm nay tăng 2%.")).toBe(false);
    expect(isModelControlText("Use the JSON tool from the docs.")).toBe(false);
  });

  it("strips tokens and headers but keeps the real text", () => {
    expect(
      stripModelControlTokens(
        "Xin chào <|channel|>commentary to=functions.web_search <|constrain|>json bạn",
      ),
    ).toBe("Xin chào bạn");
  });

  it("cleans stored bot text the way the live filter does", () => {
    const leak = '<|channel|>commentary to=functions.web_search <|message|>{"q":"giá vàng"}';
    const blocks = [
      { kind: "text", text: leak },
      { kind: "text", text: "assistant<|channel|>commentary to=functions.web_search" },
      { kind: "text", text: "The tool invocation had syntax errors. Need proper JSON." },
      { kind: "text", text: "Giá vàng hôm nay tăng 2%. <|channel|>commentary to=functions.x" },
      { kind: "text", text: "Giá vàng hôm nay tăng 2%." },
      { kind: "steps", steps: [] },
    ];
    expect(sanitizeStoredBlocks("bot", blocks)).toEqual([
      { kind: "text", text: "Giá vàng hôm nay tăng 2%." },
      { kind: "text", text: "Giá vàng hôm nay tăng 2%." },
      { kind: "steps", steps: [] },
    ]);
  });

  it("leaves clean bot blocks and every user or system block as stored", () => {
    const clean = [{ kind: "text", text: "Xin chào" }];
    expect(sanitizeStoredBlocks("bot", clean)).toBe(clean);
    const typed = [{ kind: "text", text: "Mình gõ <|channel|> thử xem" }];
    expect(sanitizeStoredBlocks("user", typed)).toBe(typed);
    expect(sanitizeStoredBlocks("system", typed)).toBe(typed);
  });
});
