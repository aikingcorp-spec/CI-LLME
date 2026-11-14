import { mkdtempSync } from "node:fs";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{4,5}$/;

export type SmokeStack = {
  start(): Promise<{ phase: string; message: string | null }>;
  stop(): Promise<unknown>;
  webUrl(): string;
  matchesDesiredStack(): Promise<boolean>;
};

export function loopbackWebUrl(value: string): boolean {
  if (!LOOPBACK.test(value)) return false;
  const port = Number(new URL(value).port);
  return port >= 1024 && port <= 65535;
}

export function smokeReadyLine(web: string): string {
  return `RAKAZO_DESKTOP_SMOKE ready postgres=up api=up worker=up web=${web}`;
}

export function smokeOkLine(web: string): string {
  return `RAKAZO_DESKTOP_SMOKE ok ${web}`;
}

/** A packaged boot counts only when it exits 0 on a loopback stack it actually started. */
export function acceptSmokeOutput(
  stdout: string,
  exitCode: number,
): { ok: true; web: string } | { ok: false; reason: string } {
  if (exitCode !== 0) return { ok: false, reason: "Packaged smoke exited non-zero." };
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("RAKAZO_DESKTOP_SMOKE "));
  const ready = lines.find((line) => line.startsWith("RAKAZO_DESKTOP_SMOKE ready "));
  const ok = lines.find((line) => line.startsWith("RAKAZO_DESKTOP_SMOKE ok "));
  const web = ok?.slice("RAKAZO_DESKTOP_SMOKE ok ".length) ?? "";
  const readyWeb = ready?.slice(
    "RAKAZO_DESKTOP_SMOKE ready postgres=up api=up worker=up web=".length,
  );
  if (
    ready !== smokeReadyLine(web) ||
    ok !== smokeOkLine(web) ||
    readyWeb !== web ||
    !loopbackWebUrl(web)
  ) {
    return {
      ok: false,
      reason: "Packaged smoke did not report a loopback postgres, api, worker, and web.",
    };
  }
  return { ok: true, web };
}

/**
 * Smoke uses an explicit temporary profile. An unset profile would otherwise be the
 * desktop user's real data directory.
 */
export function ensureSmokeUserData(
  env: NodeJS.ProcessEnv,
  createTemp: (prefix: string) => string = (prefix) => mkdtempSync(prefix),
) {
  if (env.RAKAZO_DESKTOP_SMOKE !== "1") return;
  if (env.RAKAZO_PERFORMANCE_USER_DATA?.trim()) return;
  env.RAKAZO_PERFORMANCE_USER_DATA = createTemp(path.join(tmpdir(), "vnbot-desktop-smoke-"));
}

function failureCheck(message: string | null): "identity" | "postgres" | "startup" {
  if (
    message === "Native identity setup is required." ||
    message === "Invalid identity exchange configuration" ||
    message === "Identity exchange rejected"
  ) {
    return "identity";
  }
  if (message === "Native bundle must provide PostgreSQL 18.") return "postgres";
  return "startup";
}

/** Starts the native stack, reports loopback readiness, then stops the processes it owns. */
export async function runNativeSmoke(input: {
  stack: SmokeStack;
  userDataDir: string;
  print?: (line: string) => void;
  printError?: (line: string) => void;
}): Promise<0 | 1> {
  const print = input.print ?? ((line: string) => console.log(line));
  const printError = input.printError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fail = async (
    check: "identity" | "postgres" | "startup" | "health" | "web" | "shutdown",
  ) => {
    if (check !== "shutdown") {
      printError("RAKAZO_DESKTOP_SMOKE stage=shutdown");
      try {
        await input.stack.stop();
      } catch {
        print("RAKAZO_DESKTOP_SMOKE fail shutdown");
        return 1 as const;
      }
    }
    print(`RAKAZO_DESKTOP_SMOKE fail ${check}`);
    return 1 as const;
  };

  try {
    await access(input.userDataDir);
  } catch {
    print("RAKAZO_DESKTOP_SMOKE fail startup");
    return 1;
  }

  printError("RAKAZO_DESKTOP_SMOKE stage=startup");
  let state: { phase: string; message: string | null };
  try {
    state = await input.stack.start();
  } catch (error) {
    printError(`RAKAZO_DESKTOP_SMOKE reason=${error instanceof Error ? error.message : "unknown"}`);
    return fail("startup");
  }
  if (state.phase !== "ready") {
    printError(`RAKAZO_DESKTOP_SMOKE reason=${state.phase}: ${state.message ?? ""}`);
    return fail(failureCheck(state.message));
  }

  const web = input.stack.webUrl();
  if (!loopbackWebUrl(web)) return fail("web");

  printError("RAKAZO_DESKTOP_SMOKE stage=health");
  let healthy = false;
  try {
    healthy = await input.stack.matchesDesiredStack();
  } catch {
    healthy = false;
  }
  if (!healthy) return fail("health");

  printError("RAKAZO_DESKTOP_SMOKE stage=shutdown");
  try {
    await input.stack.stop();
  } catch {
    print("RAKAZO_DESKTOP_SMOKE fail shutdown");
    return 1;
  }
  print(smokeReadyLine(web));
  print(smokeOkLine(web));
  return 0;
}
