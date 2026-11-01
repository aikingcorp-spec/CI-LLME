import type { IceServer } from "node-datachannel";

export interface TurnConfig {
  secret: string;
  urls: string[];
  ttlSeconds: number;
}
/** Gateway wire response, directly usable as a browser ICE server. */
export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
}
export interface TurnCredentials {
  username: string;
  credential: string;
  ttlSeconds: number;
  expiresAt: number;
  urls: string[];
}

export const MAX_TTL_SECONDS = 3600;
const DEFAULT_TURN_PORT = 3478;
const DEFAULT_TURNS_PORT = 5349;

/** coturn `use-auth-secret` / TURN REST API: username is `<expiry>:<peer>`, credential is HMAC-SHA1 of it. */
export async function mintTurnCredentials(
  cfg: TurnConfig,
  peerId: string,
  nowMs = Date.now(),
): Promise<TurnCredentials> {
  if (
    !Number.isInteger(cfg.ttlSeconds) ||
    cfg.ttlSeconds <= 0 ||
    cfg.ttlSeconds > MAX_TTL_SECONDS
  ) {
    throw new Error(`ttlSeconds must be an integer in 1..${MAX_TTL_SECONDS}`);
  }
  if (peerId === "" || peerId.includes(":")) {
    throw new Error("peerId must be non-empty and must not contain ':'");
  }
  const expiresAt = Math.floor(nowMs / 1000) + cfg.ttlSeconds;
  const username = `${expiresAt}:${peerId}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cfg.secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return { username, credential, ttlSeconds: cfg.ttlSeconds, expiresAt, urls: [...cfg.urls] };
}

function parseTurnUrl(url: string, username: string, password: string): IceServer {
  const match =
    /^(turns?):(?:\[([^\]\s]+)\]|([^:?/#@\s]+))(?::(\d+))?(?:\?transport=(udp|tcp))?$/.exec(url);
  const scheme = match?.[1];
  const hostname = match?.[2] ?? match?.[3];
  if (scheme === undefined || hostname === undefined) throw new Error(`invalid TURN url: ${url}`);
  const secure = scheme === "turns";
  const port = match?.[4] ? Number(match[4]) : secure ? DEFAULT_TURNS_PORT : DEFAULT_TURN_PORT;
  if (port < 1 || port > 65535 || (secure && match?.[5] === "udp"))
    throw new Error("invalid TURN transport or port");
  const relayType = secure ? "TurnTls" : match?.[5] === "tcp" ? "TurnTcp" : "TurnUdp";
  return { hostname, port, username, password, relayType };
}

/** node-datachannel 0.32 accepts structured `IceServer` objects, so no URL-embedded credentials. */
export function toNodeDatachannelIceServers(
  c: Pick<TurnCredentials, "urls" | "username" | "credential">,
): IceServer[] {
  return c.urls.map((url) => parseTurnUrl(url, c.username, c.credential));
}
