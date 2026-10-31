export const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

interface SignalSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export interface NativeShutdownInput {
  /** `process`, or a fake. */
  proc: SignalSource;
  /** Stops the native stack, postgres last. */
  stop: () => Promise<void>;
  /** Synchronous fallback when the graceful stop failed or the process is exiting. */
  stopSync: () => void;
  exit: (code: number) => void;
  /** After this the graceful stop is abandoned for `stopSync`. */
  timeoutMs?: number;
}

/**
 * A signal such as SIGTERM ends Electron without `before-quit`, and the bundled postgres
 * is a daemon that outlives it. Stop it first, then exit; a second signal while stopping
 * is ignored so the stop is not cut short.
 */
export function installNativeShutdown(input: NativeShutdownInput): () => void {
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? 20_000);
    });
    void Promise.race([input.stop().then(() => "stopped" as const), timeout])
      .catch(() => "failed" as const)
      .then((outcome) => {
        clearTimeout(timer);
        if (outcome !== "stopped") input.stopSync();
        input.exit(0);
      });
  };
  const onExit = () => input.stopSync();
  for (const signal of SHUTDOWN_SIGNALS) input.proc.on(signal, onSignal);
  input.proc.on("exit", onExit);
  return () => {
    for (const signal of SHUTDOWN_SIGNALS) input.proc.off(signal, onSignal);
    input.proc.off("exit", onExit);
  };
}
