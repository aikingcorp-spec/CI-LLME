import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./setup-state.js", import.meta.url), "utf8");
const root = {} as {
  rakazoSetupState: { initial: () => State; transition: (state: State, event: Event) => State };
};
new Function("globalThis", source)(root);
const { initial, transition } = root.rakazoSetupState;
type State = {
  phase: string;
  generation: number;
  stack: unknown;
  code: string | null;
  messageVi: string | null;
};
type Event = {
  type: string;
  generation?: number;
  stack?: { phase: string; message: string | null };
  code?: string;
  messageVi?: string;
};
const stack = (phase: string, message: string | null = null) => ({ phase, message });

describe("setup state", () => {
  it("retries a failed probe until the page answers", () => {
    let state = transition(initial(), { type: "start" });
    state = transition(state, { type: "stack", generation: 1, stack: stack("ready") });
    expect(state.phase).toBe("probing");
    state = transition(state, { type: "probe-ready", generation: 1 });
    expect(state.phase).toBe("ready");
  });
  it("ignores a stale failure after ready", () => {
    let state = transition(initial(), { type: "start" });
    state = transition(state, { type: "stack", generation: 1, stack: stack("ready") });
    state = transition(state, { type: "probe-ready", generation: 1 });
    expect(
      transition(state, { type: "failure", generation: 0, code: "probe", messageVi: "Lỗi" }),
    ).toBe(state);
  });
  it("retires an old probe when retry starts", () => {
    let state = transition(initial(), { type: "start" });
    state = transition(state, { type: "stack", generation: 1, stack: stack("ready") });
    state = transition(state, { type: "start" });
    expect(transition(state, { type: "probe-ready", generation: 1 })).toBe(state);
    expect(state.phase).toBe("starting");
  });
  it("reports a start failure", () => {
    const state = transition(initial(), { type: "start" });
    expect(
      transition(state, {
        type: "failure",
        generation: 1,
        code: "start",
        messageVi: "Không thể khởi động",
      }),
    ).toMatchObject({ phase: "failed", code: "start" });
  });
  it("a second click cannot make an old result current", () => {
    let state = transition(initial(), { type: "start" });
    state = transition(state, { type: "start" });
    expect(transition(state, { type: "stack", generation: 1, stack: stack("ready") })).toBe(state);
  });
});
