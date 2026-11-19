import type { McpTransport, MessageBlock } from "@rakazo/contracts";
import { McpRemoteEndpointSchema, McpTransportSchema } from "@rakazo/contracts";
import { deriveMcpSlug } from "@rakazo/core";
import type { McpServer } from "@rakazo/db";
import { isUniqueViolation } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ExecutorDeps } from "./executor-deps.js";
import { isNpxCommand, parseNpxLaunch } from "./mcp-package-installer.js";
import { mcpStdioAvailable, mcpStdioRefusal } from "./mcp-transport.js";
import { toStringRecord } from "./memory-provider-factory.js";
import { assertNoMcpEndpointCredential, assertSafeRemoteUrl } from "./remote-mcp.js";
import { persistMessageInTransaction, runLeaseFor } from "./run-messages.js";

export { deriveMcpSlug } from "@rakazo/core";

const MAX_HEADERS = 32;
const MAX_STDIO_ARGS = 64;
const MAX_STDIO_ARG_LENGTH = 2048;
const MAX_STDIO_COMMAND_LENGTH = 512;
const MAX_STDIO_ENV = 32;
const MAX_STDIO_ENV_VALUE_LENGTH = 4096;
const STDIO_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SECRET_FLAG_NAMES = new Set([
  "--token",
  "--api-key",
  "--apikey",
  "--key",
  "--secret",
  "--password",
  "--pass",
  "--auth",
  "--bearer",
  "--access-token",
  "--client-secret",
  "-k",
]);

const SECRET_FLAG_PATTERN = /^--[a-z0-9-]*(?:token|key|secret|password|pass|auth|bearer)$/i;

const SECRET_VALUE_PREFIX =
  /^(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|ak_[A-Za-z0-9_-]{8,}|ck_[A-Za-z0-9_-]{8,}|Bearer\s+\S+)$/i;

function isSecretKeyName(name: string): boolean {
  return /(?:token|key|secret|password|pass|auth|bearer)/i.test(name);
}

/**
 * Compact, secret-redacted command summary shown on chat approval cards for stdio servers.
 * Masks values following secret-like flags, `KEY=VALUE` pairs with secret-like keys, and
 * common token literals so credentials never appear in plaintext chat history.
 */
export function formatStdioApprovalSummary(command: string, args: readonly string[]): string {
  const parts: string[] = [command.trim()];
  let redactNext = false;
  for (const raw of args) {
    if (redactNext) {
      parts.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const lower = raw.toLowerCase();
    if (SECRET_FLAG_NAMES.has(lower) || SECRET_FLAG_PATTERN.test(raw)) {
      parts.push(raw);
      redactNext = true;
      continue;
    }
    const eqIdx = raw.indexOf("=");
    if (eqIdx > 0) {
      const lhs = raw.slice(0, eqIdx);
      const rhs = raw.slice(eqIdx + 1);
      if (
        SECRET_FLAG_NAMES.has(lhs.toLowerCase()) ||
        SECRET_FLAG_PATTERN.test(lhs) ||
        isSecretKeyName(lhs) ||
        SECRET_VALUE_PREFIX.test(rhs)
      ) {
        parts.push(`${lhs}=[REDACTED]`);
        continue;
      }
    }
    if (SECRET_VALUE_PREFIX.test(raw)) {
      parts.push("[REDACTED]");
      continue;
    }
    parts.push(raw);
  }
  const summary = parts.join(" ");
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

export type ParsedRemoteMcpServerArgs = {
  slug: string;
  name: string;
  description: string;
  transport: Exclude<McpTransport, "stdio">;
  endpoint: string;
  headers: Record<string, string>;
  secret?: string;
  assignToSelf: boolean;
};

export type ParsedStdioMcpServerArgs = {
  slug: string;
  name: string;
  description: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  assignToSelf: true;
};

export type ParsedMcpServerArgs = ParsedRemoteMcpServerArgs | ParsedStdioMcpServerArgs;

/** Returns undefined for anything that would fail server-side validation,
 * so the model gets a single actionable error instead of a partial create. */
export function parseMcpServerToolArgs(
  args: Record<string, unknown>,
  options?: { allowStdio?: boolean },
): ParsedMcpServerArgs | undefined {
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 120) : "";
  if (!name) return undefined;
  const parsedTransport = McpTransportSchema.safeParse(args.transport);
  if (!parsedTransport.success) return undefined;
  const transport = parsedTransport.data;
  const description = typeof args.description === "string" ? args.description.slice(0, 2000) : "";

  if (transport === "stdio") {
    if (options?.allowStdio !== true) return undefined;
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command || command.length > MAX_STDIO_COMMAND_LENGTH) return undefined;

    const cmdArgs: string[] = [];
    if (args.args !== undefined) {
      if (!Array.isArray(args.args) || args.args.length > MAX_STDIO_ARGS) return undefined;
      for (const item of args.args) {
        if (typeof item !== "string" || item.length > MAX_STDIO_ARG_LENGTH) return undefined;
        cmdArgs.push(item);
      }
    }

    const rawEnv = toStringRecord(args.env);
    const envEntries = Object.entries(rawEnv);
    if (envEntries.length > MAX_STDIO_ENV) return undefined;
    const env: Record<string, string> = {};
    for (const [key, value] of envEntries) {
      if (!STDIO_ENV_KEY_RE.test(key) || value.length > MAX_STDIO_ENV_VALUE_LENGTH) {
        return undefined;
      }
      env[key] = value;
    }

    return {
      slug: deriveMcpSlug(name),
      name,
      description,
      transport: "stdio",
      command,
      args: cmdArgs,
      env,
      headers: {},
      // Local command servers always require explicit user approval via the chat card.
      assignToSelf: true,
    };
  }

  const endpoint = typeof args.endpoint === "string" ? args.endpoint.trim() : "";
  if (!McpRemoteEndpointSchema.safeParse(endpoint).success) return undefined;

  const headers = toStringRecord(args.headers);
  if (Object.keys(headers).length > MAX_HEADERS) return undefined;

  return {
    slug: deriveMcpSlug(name),
    name,
    description,
    transport,
    endpoint,
    headers,
    secret:
      typeof args.secret === "string" && args.secret ? args.secret.slice(0, 16384) : undefined,
    assignToSelf: args.assign_to_self !== false,
  };
}

/** Serialized credential blob for the encrypted secret store; null when the
 * server has no static credential material. */
export function buildMcpCredentialBlob(parsed: {
  secret?: string;
  /** Stdio launch arguments, which may carry tokens. */
  args?: string[];
  env?: Record<string, string>;
  files?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
    scope?: string;
    authorizationServer?: string;
    authorizationParams?: string;
  } | null;
}): string | null {
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  const files = parsed.files ?? {};
  const args = parsed.args ?? [];
  const client = parsed.oauthClient;
  if (
    !parsed.secret &&
    args.length === 0 &&
    !client &&
    Object.keys(env).length === 0 &&
    Object.keys(headers).length === 0 &&
    Object.keys(files).length === 0
  ) {
    return null;
  }
  return JSON.stringify({
    secret: parsed.secret,
    env,
    headers,
    ...(Object.keys(files).length > 0 ? { files } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(client
      ? {
          oauthClient: {
            client_id: client.clientId,
            ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
            ...(client.scope ? { scope: client.scope } : {}),
            ...(client.authorizationParams
              ? { authorization_params: client.authorizationParams }
              : {}),
            ...(client.authorizationServer
              ? { authorization_server: new URL(client.authorizationServer).href }
              : {}),
          },
        }
      : {}),
  });
}

/** Heuristic for whether the approval card should lead with OAuth: remote
 * servers without a static credential usually need browser authorization. */
export function needsOAuthProbe(parsed: {
  transport: string;
  secret?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}): boolean {
  if (parsed.transport === "stdio") return false;
  const env = parsed.env ?? {};
  const headers = parsed.headers ?? {};
  return !parsed.secret && Object.keys(env).length === 0 && Object.keys(headers).length === 0;
}

/** add_mcp_server: registers the server and, when asked, posts its approval card. */
export async function addMcpServerFromTool(
  deps: ExecutorDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  botId: string,
  args: Record<string, unknown>,
  executionId: string,
) {
  const stdioPolicy = deps.mcpStdioPolicy ?? {};
  const stdioEnabled = mcpStdioAvailable(stdioPolicy);
  // Multi-tenant/cloud deployments disable stdio by default so only an admin adds local servers.
  if (args.transport === "stdio" && !stdioEnabled) {
    return {
      error: "Bots can't add local (stdio) MCP servers. Ask an admin to add it in Settings.",
    };
  }
  const parsed = parseMcpServerToolArgs(args, { allowStdio: stdioEnabled });
  if (!parsed) {
    return {
      error:
        args.transport === "stdio"
          ? 'Invalid stdio MCP server details. Required: name, transport ("stdio"), command, and optional args/env.'
          : "Invalid MCP server details. Required: name, transport (streamable_http|sse), and an endpoint URL.",
    };
  }
  if (parsed.transport === "stdio") {
    const refusal = mcpStdioRefusal(parsed.command, stdioPolicy);
    if (refusal) {
      return { error: refusal };
    }
    if (isNpxCommand(parsed.command) && !parseNpxLaunch(parsed.command, parsed.args)) {
      return {
        error:
          'Invalid npx MCP launch arguments. Use a plain npm registry package such as ["-y", "@scope/mcp-server"].',
      };
    }
  } else {
    try {
      await assertSafeRemoteUrl(parsed.endpoint, deps.secretHttp?.resolveHostname, {
        allowPrivateEndpoint: deps.mcpAllowPrivateEndpoint === true,
      });
      assertNoMcpEndpointCredential(parsed.endpoint);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Invalid MCP endpoint",
      };
    }
  }
  if (!deps.secretStore) {
    return {
      error: "Secret storage is not available in this deployment.",
    };
  }
  const credentialBlob = buildMcpCredentialBlob(parsed);
  let storedCredential: { id: string; ciphertext: string } | null = null;
  if (credentialBlob) {
    storedCredential = await deps.secretStore.put(credentialBlob, {
      operationId: executionId,
      traceId: executionId,
      spaceId: run.spaceId,
      userId: run.userId,
      botId,
      signal: new AbortController().signal,
    });
  }
  const oauthLikely = needsOAuthProbe(parsed);
  const approvalEndpoint =
    parsed.transport === "stdio"
      ? formatStdioApprovalSummary(parsed.command, parsed.args)
      : parsed.endpoint;
  let serverRow: McpServer;
  let approvalEventSeq: number | undefined;
  let approvalResponseRunId: string | undefined;
  try {
    const created = await deps.prisma.$transaction(async (tx) => {
      if (storedCredential) {
        await tx.secret.create({
          data: {
            id: storedCredential.id,
            userId: run.userId,
            spaceId: run.spaceId,
            kind: "mcp",
            ciphertext: storedCredential.ciphertext,
          },
        });
      }
      const server = await tx.mcpServer.create({
        data:
          parsed.transport === "stdio"
            ? {
                spaceId: run.spaceId,
                userId: run.userId,
                slug: parsed.slug,
                name: parsed.name,
                description: parsed.description,
                transport: parsed.transport,
                endpoint: null,
                command: parsed.command,
                hasArgs: parsed.args.length > 0,
                env: Object.fromEntries(Object.keys(parsed.env).map((key) => [key, true])),
                headers: {},
                secretId: storedCredential?.id,
                enabled: true,
              }
            : {
                spaceId: run.spaceId,
                userId: run.userId,
                slug: parsed.slug,
                name: parsed.name,
                description: parsed.description,
                transport: parsed.transport,
                endpoint: parsed.endpoint,
                headers: Object.fromEntries(Object.keys(parsed.headers).map((key) => [key, true])),
                secretId: storedCredential?.id,
                enabled: true,
              },
      });
      if (!parsed.assignToSelf) return { server };
      const blocks: MessageBlock[] = [
        {
          kind: "mcp_approval",
          name: server.name,
          serverId: server.id,
          transport: parsed.transport,
          endpoint: approvalEndpoint,
          needsOAuth: oauthLikely,
          status: "pending",
        },
      ];
      const committed = await persistMessageInTransaction(
        tx,
        run,
        "bot",
        blocks,
        undefined,
        undefined,
        false,
        runLeaseFor(deps, run.id),
      );
      return {
        server,
        eventSeq: committed.eventSeq,
        firstResponseRunId: committed.firstResponseRunId,
      };
    });
    serverRow = created.server;
    approvalEventSeq = created.eventSeq;
    approvalResponseRunId = created.firstResponseRunId;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        error: `An MCP server named "${parsed.name}" already exists. Ask the user to remove it first or pick another name.`,
      };
    }
    throw error;
  }
  if (approvalEventSeq !== undefined) {
    await deps.events
      .notify(run.threadId, approvalEventSeq, approvalResponseRunId)
      .catch((error) => {
        getLogger().error("MCP approval realtime notification", error);
      });
  }
  return {
    ok: true,
    server_id: serverRow.id,
    next_step: parsed.assignToSelf
      ? `An approval card is in the chat. End your turn with one short sentence asking the user to ${oauthLikely ? "authorize" : "approve"} it there; the card already shows the server's details. You will be told when they connect it.`
      : "The server was registered without assigning it to this bot.",
  };
}
