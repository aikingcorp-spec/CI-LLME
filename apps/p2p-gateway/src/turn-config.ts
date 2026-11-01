import type { TurnConfig } from "../../../packages/p2p-prototype/src/turn-credentials.js";
import {
  MAX_TTL_SECONDS,
  toNodeDatachannelIceServers,
} from "../../../packages/p2p-prototype/src/turn-credentials.js";
import type { Env } from "./env.js";

/** Missing or malformed optional TURN settings leave the endpoint disabled. */
export function loadTurnConfig(
  env: Pick<Env, "TURN_SECRET" | "TURN_URLS" | "TURN_TTL_SECONDS">,
): TurnConfig | undefined {
  const secret = env.TURN_SECRET;
  const urls = (env.TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!secret || urls.length === 0) return undefined;
  const requested = Number(env.TURN_TTL_SECONDS);
  const ttlSeconds =
    Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_TTL_SECONDS) : 600;
  try {
    toNodeDatachannelIceServers({ urls, username: "validation", credential: "validation" });
    return { secret, urls, ttlSeconds };
  } catch {
    return undefined;
  }
}
