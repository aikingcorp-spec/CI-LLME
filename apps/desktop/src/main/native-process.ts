import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
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

/**
 * A server log this account cannot append to, such as one an elevated launch created, makes
 * pg_ctl refuse to start. Replace it, or log beside it, rather than keep the app from opening.
 */
export function serverLog(file: string): string {
  for (const attempt of [() => undefined, () => rmSync(file, { force: true })]) {
    try {
      attempt();
      closeSync(openSync(file, "a"));
      return file;
    } catch {}
  }
  return file.replace(/\.log$/, `-${process.pid}.log`);
}

/**
 * PostgreSQL refuses to start from a process with administrator rights, which a Windows account
 * with UAC off (or an elevated launch) has. `pg_ctl` starts the server under a restricted token,
 * as 0.3.9 did, so Windows runs it through `pg_ctl`; other platforms keep the owned child.
 */
export function createPostgresProcess(input: {
  /** The bin directory holding postgres and pg_ctl. */
  bin: string;
  dataDir: string;
  /** Server options after -D, such as -h, -p and -c settings. */
  options: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ready(signal: AbortSignal): Promise<void>;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  platform?: NodeJS.Platform;
}): NativeRuntimeService {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return createNativeProcess({
      executable: path.join(input.bin, "postgres"),
      args: ["-D", input.dataDir, ...input.options],
      cwd: input.cwd,
      env: input.env,
      ready: input.ready,
      startupTimeoutMs: input.startupTimeoutMs,
      stopTimeoutMs: input.stopTimeoutMs,
    });
  }
  const pgCtl = path.join(input.bin, "pg_ctl.exe");
  const control = (args: string[], timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(pgCtl, args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: smokeOutput({ executable: pgCtl, args: [args[0] ?? ""] }),
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("PostgreSQL control failed."));
      });
    });
  let started = false;
  return {
    async start(signal) {
      if (started) throw new Error("Native process already exists.");
      signal.throwIfAborted();
      started = true;
      try {
        await control(
          [
            "start",
            "-D",
            input.dataDir,
            "-W",
            "-s",
            "-l",
            serverLog(path.join(input.dataDir, "..", "postgres-server.log")),
            "-o",
            windowsCommandLine(input.options),
          ],
          Math.max(60_000, input.startupTimeoutMs ?? 60_000),
        );
        await input.ready(
          AbortSignal.any([signal, AbortSignal.timeout(input.startupTimeoutMs ?? 30_000)]),
        );
      } catch {
        throw new Error("Native process did not become ready.");
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      const timeout = input.stopTimeoutMs ?? 5_000;
      await control(
        ["stop", "-D", input.dataDir, "-m", "fast", "-w", "-t", String(Math.ceil(timeout / 1000))],
        timeout + 10_000,
      ).catch(() =>
        control(["stop", "-D", input.dataDir, "-m", "immediate", "-w"], 30_000).catch(() => {
          throw new Error("Native process did not stop.");
        }),
      );
    },
  };
}

const WINDOWS_CMD_SPECIAL = /[\s"&|<>^()%;,!=]/;

/**
 * Quotes each option for the Windows command line `pg_ctl` passes through `cmd.exe /c` to `postgres`.
 * Unquoted `cmd.exe` metacharacters such as `&` in a user profile path (e.g. `C:\Users\A&B\...`)
 * would otherwise split the command line before `postgres` starts.
 */
export function windowsCommandLine(args: string[]): string {
  return args
    .map((arg) =>
      arg === "" || WINDOWS_CMD_SPECIAL.test(arg)
        ? `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
        : arg,
    )
    .join(" ");
}
