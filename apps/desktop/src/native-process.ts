import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import type { NativeRuntimeService } from "./native-runtime.js";

/** Executables and environment come from the desktop composition root, never chat input. */
export function createNativeProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ready(signal: AbortSignal): Promise<void>;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
}): NativeRuntimeService {
  let owned: { child: ChildProcess; exited: Promise<void>; done: boolean } | undefined;
  return {
    async start(signal) {
      if (owned) throw new Error("Native process already exists.");
      signal.throwIfAborted();
      const child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: smokeOutput(input),
      });
      let resolveExit: () => void = () => {};
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const current = { child, exited, done: false };
      owned = current;
      const startup = new AbortController();
      const finish = () => {
        current.done = true;
        startup.abort();
        resolveExit();
      };
      child.once("error", () => {
        startup.abort();
        // A failed signal does not prove the process exited.
        if (child.pid === undefined) finish();
      });
      child.once("exit", finish);
      const combined = AbortSignal.any([
        signal,
        startup.signal,
        AbortSignal.timeout(input.startupTimeoutMs ?? 30_000),
      ]);
      try {
        // A readiness implementation must honor cancellation, including its network I/O.
        await input.ready(combined);
        combined.throwIfAborted();
        if (current.done) throw new Error("Native process exited.");
      } catch {
        throw new Error("Native process did not become ready.");
      }
    },
    async stop() {
      const current = owned;
      if (!current) return;
      const timeout = input.stopTimeoutMs ?? 5_000;
      const wait = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            current.exited.then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), timeout);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (!current.done) {
        current.child.kill("SIGTERM");
        if (!(await wait())) {
          current.child.kill("SIGKILL");
          if (!(await wait())) throw new Error("Native process did not stop.");
        }
      }
      if (owned === current) owned = undefined;
    },
  };
}

/** A packaged smoke run keeps each child's output in the temporary profile; otherwise none. */
function smokeOutput(input: {
  executable: string;
  args: string[];
}): "ignore" | ["ignore", number, number] {
  const profile = process.env.RAKAZO_PERFORMANCE_USER_DATA;
  if (process.env.RAKAZO_DESKTOP_SMOKE !== "1" || !profile) return "ignore";
  const name = path.basename(input.args[0] ?? input.executable).replace(/[^\w.-]/g, "_");
  try {
    const fd = openSync(
      path.join(profile, `native-${path.basename(input.executable)}-${name}.log`),
      "a",
    );
    return ["ignore", fd, fd];
  } catch {
    return "ignore";
  }
}
