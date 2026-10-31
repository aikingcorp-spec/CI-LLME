/** Pure setup transition reducer. Each asynchronous result belongs to one attempt. */
((root) => {
  function initial() {
    return { phase: "idle", generation: 0, stack: null, code: null, messageVi: null };
  }
  function transition(state, event) {
    if (event.type === "reset") {
      return { ...initial(), generation: state.generation + 1 };
    }
    if (event.type === "start") {
      return {
        phase: "starting",
        generation: state.generation + 1,
        stack: null,
        code: null,
        messageVi: null,
      };
    }
    if (event.generation !== state.generation) return state;
    if (event.type === "stack") {
      if (state.phase !== "starting" || event.stack.phase === "idle") return state;
      if (["failed", "docker-missing", "docker-not-running"].includes(event.stack.phase)) {
        return {
          ...state,
          phase: "failed",
          stack: event.stack,
          code: event.stack.phase,
          messageVi: event.stack.message,
        };
      }
      return {
        ...state,
        stack: event.stack,
        phase: event.stack.phase === "ready" ? "probing" : "starting",
      };
    }
    if (event.type === "probe-ready" && state.phase === "probing")
      return { ...state, phase: "ready" };
    if (event.type === "failure" && ["starting", "probing", "ready"].includes(state.phase)) {
      return { ...state, phase: "failed", code: event.code, messageVi: event.messageVi };
    }
    return state;
  }
  root.rakazoSetupState = { initial, transition };
})(typeof window === "undefined" ? globalThis : window);
