import { tmpdir } from "node:os";
import path from "node:path";
import type { HostCommandRisk } from "@rakazo/core";
import { classifyHostCommand } from "@rakazo/core";

/** Tools that start a process on the user's own computer. */
export const HOST_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  "shell",
  "launch_app",
  "open_path",
]);

/** Set by the desktop app when it is running as root or an elevated administrator. */
export const HOST_ELEVATED_ENV = "RAKAZO_HOST_COMMANDS_ELEVATED";

/**
 * VNBot never runs a bot's commands with administrator or root rights. The desktop app reports
 * that it was started that way; every process tool then refuses until it is restarted normally.
 */
export function hostCommandsElevatedRefusal(
  tool: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!HOST_PROCESS_TOOLS.has(tool) || env[HOST_ELEVATED_ENV] !== "1") return undefined;
  return "VNBot is running with administrator or root rights, so it will not run commands. Tell the user to close VNBot and open it again as a normal user.";
}

export interface HostShellInput {
  command: string;
  cwd?: string;
  environment: { platform: string; home: string; workspace?: string } | undefined;
  tempDir?: string;
}

/**
 * What a shell command on the user's own computer would do that needs a person first: delete
 * outside the bot's workspace, ask for administrator rights, read keys and credentials, or run
 * a downloaded script. Empty for a command that stays in the workspace.
 */
export function hostShellRisks(input: HostShellInput): HostCommandRisk[] {
  const environment = input.environment;
  const workspace = environment?.workspace;
  // The app's own secrets live beside the bots' folders: <data>/desktop-computers/<bot>.
  const protectedRoot =
    workspace && path.basename(path.dirname(workspace)) === "desktop-computers"
      ? path.resolve(workspace, "..", "..", "..")
      : undefined;
  return classifyHostCommand(input.command, {
    platform: environment?.platform ?? process.platform,
    home: environment?.home ?? "/",
    workspace,
    cwd: input.cwd,
    tempDir: input.tempDir ?? tmpdir(),
    protectedRoots: protectedRoot ? [protectedRoot] : [],
  });
}
