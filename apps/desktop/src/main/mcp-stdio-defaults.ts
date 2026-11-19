const POSIX_DESKTOP_MCP_STDIO_COMMANDS = ["npx", "node", "python", "python3"] as const;
const WIN32_DESKTOP_MCP_STDIO_COMMANDS = [
  "npx",
  "npx.cmd",
  "node",
  "node.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
] as const;

/**
 * Curated local stdio MCP command allowlist for Desktop installations.
 * Keeps shell interpreters and package runners blocked by policy (such as uvx/bunx/pnpx)
 * out while allowing standard Node/Python/npx MCP servers on the user's own machine.
 */
export function desktopMcpStdioAllowedCommands(platform: NodeJS.Platform): string {
  const list =
    platform === "win32" ? WIN32_DESKTOP_MCP_STDIO_COMMANDS : POSIX_DESKTOP_MCP_STDIO_COMMANDS;
  return list.join(",");
}

/**
 * Default MCP environment for Desktop local stacks (native and Docker).
 * Explicit operator env overrides are respected when provided.
 */
export function desktopMcpEnv(
  sourceEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): {
  MCP_ALLOW_PRIVATE_ENDPOINT: string;
  MCP_STDIO_ENABLED: string;
  MCP_STDIO_ALLOWED_COMMANDS: string;
} {
  return {
    MCP_ALLOW_PRIVATE_ENDPOINT: sourceEnv.MCP_ALLOW_PRIVATE_ENDPOINT ?? "true",
    MCP_STDIO_ENABLED: sourceEnv.MCP_STDIO_ENABLED ?? "true",
    MCP_STDIO_ALLOWED_COMMANDS:
      sourceEnv.MCP_STDIO_ALLOWED_COMMANDS ?? desktopMcpStdioAllowedCommands(platform),
  };
}
