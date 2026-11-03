import { authClient } from "./auth";
import { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";
import { webP2PClient } from "./p2p-client";
import { rpc } from "./rpc";

export { MCP_OAUTH_CHANNEL } from "./mcp-oauth-channel";

const MCP_OAUTH_TIMEOUT_MS = 2 * 60 * 1000;
const attemptKey = (state: string) => `vnbot:mcp-oauth:${state}`;

/** Only routing metadata is persisted. OAuth codes, PKCE and tokens stay out of storage. */
export async function completeMcpOauth(state: string, code: string): Promise<void> {
  const client = webP2PClient();
  if (client) {
    const raw = localStorage.getItem(attemptKey(state));
    if (!raw) throw new Error("This connection request is missing or expired. Start again.");
    const attempt: unknown = JSON.parse(raw);
    const session = await authClient.getSession();
    if (
      !attempt ||
      typeof attempt !== "object" ||
      !("userId" in attempt) ||
      attempt.userId !== session.data?.user.id ||
      !("nodeId" in attempt) ||
      typeof attempt.nodeId !== "string" ||
      !attempt.nodeId ||
      !("expires" in attempt) ||
      typeof attempt.expires !== "number" ||
      attempt.expires < Date.now()
    )
      throw new Error("This connection request is missing or expired. Start again.");
    if (
      client.getSnapshot().state !== "connected" ||
      client.getSnapshot().nodeId !== attempt.nodeId
    )
      await client.connect(attempt.nodeId);
    // Never send product RPC to the hosted account service when restoration fails.
    if (
      client.getSnapshot().state !== "connected" ||
      client.getSnapshot().nodeId !== attempt.nodeId
    )
      throw new Error("Connect to the computer and try again.");
  }
  await rpc.mcp.oauth.complete({ sessionId: state, code, state });
  localStorage.removeItem(attemptKey(state));
}

export type McpOauthResult =
  | "connected"
  | "cancelled"
  | "already_connected"
  | "authorization_not_requested";

/** Run the browser OAuth popup flow for an MCP server: request an
 * authorization URL, open the popup, and wait until the callback page
 * broadcasts completion or the popup is closed without finishing.
 *
 * The BroadcastChannel (not window.opener) is the completion signal because
 * provider login pages with COOP sever the opener link. */
/** Where providers send the user back; a pre-registered client must allow it. */
export function mcpOAuthRedirectUri(): string {
  return `${window.location.origin}/mcp/oauth/callback`;
}

export async function connectMcpOauth(serverId: string): Promise<McpOauthResult> {
  // Reserve the window while the browser still has the user's click activation.
  const popup = window.open(
    "about:blank",
    `${MCP_OAUTH_CHANNEL}:${crypto.randomUUID()}`,
    "popup,width=560,height=720",
  );
  let started: Awaited<ReturnType<typeof rpc.mcp.oauth.begin>>;
  try {
    const client = webP2PClient();
    const nodeId = client?.getSnapshot().nodeId;
    const session = client ? await authClient.getSession() : undefined;
    if (
      client &&
      (!nodeId || client.getSnapshot().state !== "connected" || !session?.data?.user.id)
    )
      throw new Error("Connect to the computer and try again.");
    started = await rpc.mcp.oauth.begin({ serverId, redirectUri: mcpOAuthRedirectUri() });
    if (started.status !== "authorization_required") {
      popup?.close();
      return started.status;
    }
    if (client)
      localStorage.setItem(
        attemptKey(started.sessionId),
        JSON.stringify({
          nodeId,
          userId: session!.data!.user.id,
          expires: Date.now() + MCP_OAUTH_TIMEOUT_MS,
        }),
      );
  } catch (error) {
    popup?.close();
    throw error;
  }
  if (!popup) {
    // Popup blocked: navigate this tab instead; the callback page returns to /app.
    window.location.assign(started.authorizationUrl);
    return "cancelled";
  }
  return await new Promise<McpOauthResult>((resolve) => {
    const channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
    let settled = false;
    let pollTimer = 0;
    let timeoutTimer = 0;
    const finish = (result: McpOauthResult) => {
      if (settled) return;
      settled = true;
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      channel.close();
      resolve(result);
    };
    pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      finish("cancelled");
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      popup.close();
      finish("cancelled");
    }, MCP_OAUTH_TIMEOUT_MS);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; state?: string } | null;
      if (data?.type !== "mcp-oauth-complete" || data.state !== started.sessionId) return;
      finish("connected");
    };
    // Install the listener before a fast provider can return to the callback.
    popup.location.replace(started.authorizationUrl);
  });
}
