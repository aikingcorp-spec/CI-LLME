import { describe, expect, it } from "vitest";
import {
  initialAppOpenState,
  setupDetailForOpenFailure,
  transitionAppOpenState,
} from "./app-open-state.js";

describe("app open state", () => {
  it("becomes ready after a successful load", () => {
    const opening = transitionAppOpenState(initialAppOpenState, { type: "open-start" });
    const ready = transitionAppOpenState(opening, {
      type: "load-ok",
      generation: opening.generation,
    });

    expect(ready).toEqual({ kind: "ready", generation: opening.generation });
    expect(setupDetailForOpenFailure(ready, opening.generation)).toBeNull();
  });

  it("shows setup with the failed load's detail", () => {
    const opening = transitionAppOpenState(initialAppOpenState, { type: "open-start" });
    const failed = transitionAppOpenState(opening, {
      type: "load-failed",
      generation: opening.generation,
      detail: "The page did not load",
    });

    expect(failed).toEqual({
      kind: "error",
      generation: opening.generation,
      detail: "The page did not load",
    });
    expect(setupDetailForOpenFailure(failed, opening.generation)).toBe("The page did not load");
  });

  it("does not show setup for an error after quit starts", () => {
    const opening = transitionAppOpenState(initialAppOpenState, { type: "open-start" });
    const quitting = transitionAppOpenState(opening, { type: "quit" });
    const failed = transitionAppOpenState(quitting, {
      type: "load-failed",
      generation: opening.generation,
      detail: "Late failure",
    });

    expect(failed).toEqual(quitting);
    expect(setupDetailForOpenFailure(failed, opening.generation)).toBeNull();
  });

  it("ignores a stale failure after a newer attempt is ready", () => {
    const first = transitionAppOpenState(initialAppOpenState, { type: "open-start" });
    const second = transitionAppOpenState(first, { type: "open-start" });
    const stillOpening = transitionAppOpenState(second, {
      type: "load-failed",
      generation: first.generation,
      detail: "Old failure",
    });
    expect(stillOpening).toEqual(second);
    const ready = transitionAppOpenState(stillOpening, {
      type: "load-ok",
      generation: second.generation,
    });
    const stale = transitionAppOpenState(ready, {
      type: "load-failed",
      generation: first.generation,
      detail: "Old failure",
    });

    expect(stale).toEqual(ready);
    expect(setupDetailForOpenFailure(stale, first.generation)).toBeNull();
  });

  it("keeps quitting when an in-flight load succeeds", () => {
    const opening = transitionAppOpenState(initialAppOpenState, { type: "open-start" });
    const quitting = transitionAppOpenState(opening, { type: "quit" });
    const loaded = transitionAppOpenState(quitting, {
      type: "load-ok",
      generation: opening.generation,
    });

    expect(loaded).toEqual(quitting);
    expect(setupDetailForOpenFailure(loaded, opening.generation)).toBeNull();
  });
});
