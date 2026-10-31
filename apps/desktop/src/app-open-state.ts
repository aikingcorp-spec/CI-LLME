export type AppOpenState =
  | { kind: "idle"; generation: number }
  | { kind: "opening"; generation: number }
  | { kind: "ready"; generation: number }
  | { kind: "error"; generation: number; detail: string }
  | { kind: "quitting"; generation: number };

export type AppOpenEvent =
  | { type: "open-start" }
  | { type: "load-ok"; generation: number }
  | { type: "load-failed"; generation: number; detail: string }
  | { type: "quit" }
  | { type: "resume" };

export const initialAppOpenState: AppOpenState = { kind: "idle", generation: 0 };

export function transitionAppOpenState(state: AppOpenState, event: AppOpenEvent): AppOpenState {
  if (event.type === "quit") return { kind: "quitting", generation: state.generation };
  // A failed updater install can return control to the running app.
  if (event.type === "resume")
    return state.kind === "quitting" ? { kind: "idle", generation: state.generation } : state;
  if (state.kind === "quitting") return state;
  if (event.type === "open-start") return { kind: "opening", generation: state.generation + 1 };
  if (state.kind !== "opening" || event.generation !== state.generation) return state;
  if (event.type === "load-ok") return { kind: "ready", generation: state.generation };
  return { kind: "error", generation: state.generation, detail: event.detail };
}

export function setupDetailForOpenFailure(state: AppOpenState, generation: number): string | null {
  return state.kind === "error" && state.generation === generation ? state.detail : null;
}
