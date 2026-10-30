import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { filterModelControlText } from "./model-control-filter.js";

async function run(events: AgentRuntimeEvent[]) {
  async function* source() {
    yield* events;
  }
  const out: AgentRuntimeEvent[] = [];
  for await (const event of filterModelControlText(source())) out.push(event);
  return out;
}
const text = (out: AgentRuntimeEvent[]) =>
  out.map((e) => (e.type === "text" ? e.text : "")).join("");
const RETRY = { type: "progress", text: "Không gọi được công cụ, đang thử lại…", activity: true };

describe("filterModelControlText", () => {
  it("passes a normal reply through unchanged", async () => {
    const out = await run([
      { type: "text", text: "Tiêu đề đầu tiên " },
      { type: "text", text: "là: Giá vàng tăng." },
      { type: "done" },
    ]);
    expect(text(out)).toBe("Tiêu đề đầu tiên là: Giá vàng tăng.");
    expect(out.some((e) => e.type === "progress")).toBe(false);
  });

  it("drops the model's tool-call retry talk and shows one Vietnamese line", async () => {
    const out = await run([
      { type: "text", text: "The tool invocation had syntax errors. Need proper JSON " },
      { type: "text", text: "with all keys. Let's try again." },
      { type: "turn" },
      { type: "text", text: "Assistant<|channel|>commentary to=functions.web_search " },
      { type: "text", text: '<|constrain|>json {"query":"x"}' },
      { type: "turn" },
      { type: "text", text: "Giá vàng SJC hôm nay là 120 triệu." },
      { type: "done" },
    ]);
    expect(text(out)).toBe("Giá vàng SJC hôm nay là 120 triệu.");
    expect(out.filter((e) => e.type === "progress")).toEqual([RETRY]);
    expect(JSON.stringify(out)).not.toMatch(/<\||to=functions|syntax errors/u);
  });

  it("cuts a message at a control token that arrives after clean text", async () => {
    const out = await run([
      { type: "text", text: "Mình sẽ tìm giá vàng cho bạn. ".repeat(8) },
      { type: "text", text: "Đang tìm <|channel|>commentary to=functions.web_search" },
      { type: "text", text: " more leaked text" },
      { type: "done" },
    ]);
    expect(text(out)).toBe(`${"Mình sẽ tìm giá vàng cho bạn. ".repeat(8)}Đang tìm `);
    expect(out).toContainEqual(RETRY);
  });

  it("cleans the final text a runtime hands back on done", async () => {
    const out = await run([{ type: "done", text: "<|start|>assistant<|message|>Xin chào" }]);
    expect(out).toEqual([{ type: "done", text: "" }]);
    const clean = await run([{ type: "done", text: "Xin chào" }]);
    expect(clean).toEqual([{ type: "done", text: "Xin chào" }]);
  });
});
