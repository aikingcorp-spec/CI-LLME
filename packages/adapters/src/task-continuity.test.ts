import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { TaskContinuity } from "./task-continuity.js";

const options = { paused: false, aborted: false, steered: false, budgetExceeded: false };
const turn = (tools = false): AgentTurnContext =>
  ({
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "Progress" }],
    },
    toolResults: tools ? [{ role: "toolResult" }] : [],
    context: { messages: [] },
    newMessages: [],
  }) as unknown as AgentTurnContext;

describe("bounded task continuity scheduling", () => {
  it("does no review for ordinary text replies or when not opted in", () => {
    expect(new TaskContinuity(true).shouldReview(turn(), options)).toBe(false);
    expect(new TaskContinuity(false).shouldReview(turn(), { ...options, steered: true })).toBe(
      false,
    );
  });
  it("reviews a stopping reply after tool work, but not the tool turn itself", () => {
    const guard = new TaskContinuity(true);
    expect(guard.shouldReview(turn(true), options)).toBe(false);
    expect(guard.shouldReview(turn(), options)).toBe(true);
  });
  it.each(["paused", "aborted", "budgetExceeded"] as const)("never overrides %s", (flag) => {
    expect(
      new TaskContinuity(true).shouldReview(turn(), { ...options, steered: true, [flag]: true }),
    ).toBe(false);
  });
  it("continues only a structured incomplete decision and caps review calls", async () => {
    const guard = new TaskContinuity(true);
    const evaluate = vi.fn(async () =>
      JSON.stringify({ outcome: "continue", nextStep: "Create the remaining three teammates." }),
    );
    expect(await guard.review(evaluate)).toContain("remaining three");
    await guard.review(evaluate);
    expect(await guard.review(evaluate)).toBeUndefined();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(guard.shouldReview(turn(), { ...options, steered: true })).toBe(false);
  });
  it.each(["complete", "blocked", "cancelled"])("does not retry a %s decision", async (outcome) => {
    expect(
      await new TaskContinuity(true).review(async () => JSON.stringify({ outcome })),
    ).toBeUndefined();
  });
  it("treats a malformed review as unqualified, never as a pass or continuation", async () => {
    await expect(new TaskContinuity(true).review(async () => "invalid")).rejects.toThrow();
  });
});
