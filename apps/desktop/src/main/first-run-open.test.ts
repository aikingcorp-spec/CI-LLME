import type { DesktopSetup } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { openFirstRunLocalStack } from "./first-run-open.js";

const URL = "http://127.0.0.1:3773";

function harness(initial: DesktopSetup | null, open: (url: string) => Promise<boolean>) {
  const state = { setup: initial };
  const events: string[] = [];
  const persist = vi.fn(async (setup: DesktopSetup) => {
    events.push(`persist:${setup.mode}`);
  });
  const onRollback = vi.fn();
  const run = () =>
    openFirstRunLocalStack({
      url: URL,
      getSetup: () => state.setup,
      setSetup: (setup) => {
        state.setup = setup;
      },
      open: async (url) => {
        events.push(`open:${state.setup?.mode ?? "null"}`);
        return open(url);
      },
      persist,
      onRollback,
    });
  return { state, events, persist, onRollback, run };
}

describe("first-run local stack open", () => {
  it("is already in new mode while the page loads, then persists", async () => {
    const h = harness(null, async () => true);
    await expect(h.run()).resolves.toBe(true);
    expect(h.events).toEqual(["open:new", "persist:new"]);
    expect(h.state.setup).toEqual({ mode: "new", serverUrl: URL });
    expect(h.onRollback).not.toHaveBeenCalled();
  });

  it("restores the previous setup and persists nothing when open fails", async () => {
    const previous: DesktopSetup = { mode: "existing", serverUrl: "https://x.example.test" };
    const h = harness(previous, async () => false);
    await expect(h.run()).resolves.toBe(false);
    expect(h.state.setup).toBe(previous);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.onRollback).toHaveBeenCalledOnce();
  });

  it("restores the previous setup when open throws", async () => {
    const h = harness(null, async () => {
      throw new Error("boom");
    });
    await expect(h.run()).rejects.toThrow("boom");
    expect(h.state.setup).toBeNull();
    expect(h.persist).not.toHaveBeenCalled();
  });
});
