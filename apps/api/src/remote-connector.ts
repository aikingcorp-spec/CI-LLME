import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";

/**
 * Runs the host connector. The token is passed the way the connector documents
 * and is not written to this process's logs.
 */
export function startRemoteConnector(input: {
  /** The connector to run, or how to find it, which may download it the first time. */
  executable?: string | (() => Promise<string>);
  onError?: (error: unknown) => void;
  onStop?: () => void;
  spawnProcess?: (
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => {
    kill: () => void;
    onError?: (notify: () => void) => void;
    onExit?: (notify: (code: number | null) => void) => void;
  };
}): {
  adopt(token: string): void;
  stop(): void;
  running(): boolean;
  failed(): boolean;
} {
  const executable = input.executable ?? process.env.RAKAZO_REMOTE_CONNECTOR ?? "cloudflared";
  // One lookup at a time; a failed one is tried again on the next token.
  let finding: Promise<string> | undefined;
  const find = () => {
    if (typeof executable === "string") return executable;
    finding ??= executable().catch((error: unknown) => {
      finding = undefined;
      throw error;
    });
    return finding;
  };
  const launch =
    input.spawnProcess ??
    ((command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      const child: ChildProcess = spawn(command, [...args], {
        env,
        stdio: "ignore",
        detached: false,
      });
      child.unref();
      return {
        kill: () => child.kill(),
        onError: (notify: () => void) => child.on("error", notify),
        onExit: (notify: (code: number | null) => void) => child.on("exit", (code) => notify(code)),
      };
    });
  let current: { token: string; kill: () => void } | undefined;
  let stopped = false;
  let didFail = false;
  return {
    adopt(token: string) {
      if (current?.token === token) return;
      stopped = false;
      didFail = false;
      current?.kill();
      const handle: { token: string; kill: () => void } = { token, kill: () => undefined };
      current = handle;
      const lost = () => {
        if (current !== handle || stopped) return;
        current = undefined;
        didFail = true;
        input.onStop?.();
      };
      const start = (command: string) => {
        if (current !== handle || stopped) return;
        const child = launch(command, ["tunnel", "run", "--token", token], {
          ...process.env,
          TUNNEL_TOKEN: token,
        });
        handle.kill = child.kill;
        child.onError?.(lost);
        child.onExit?.(() => lost());
      };
      const found = find();
      if (typeof found === "string") start(found);
      else
        found.then(start, (error: unknown) => {
          input.onError?.(error);
          lost();
        });
    },
    stop() {
      stopped = true;
      didFail = false;
      current?.kill();
      current = undefined;
    },
    running() {
      return current !== undefined;
    },
    failed() {
      return didFail;
    },
  };
}
