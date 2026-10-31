import type { NodeRoom } from "./node-room.js";

export interface Env {
  /** coturn use-auth-secret shared secret; optional. */
  TURN_SECRET?: string;
  /** Comma-separated TURN/TURNS URLs. */
  TURN_URLS?: string;
  TURN_TTL_SECONDS?: string;
  DB: D1Database;
  NODE_ROOM: DurableObjectNamespace<NodeRoom>;
  /** Secret. Raw 32-byte Ed25519 private key, base64url. */
  GATEWAY_PRIVATE_KEY: string;
  GATEWAY_PUBLIC_KEY: string;
  GATEWAY_KEY_ID: string;
  /** JSON object: key id to base64url Ed25519 public key. */
  APP_TOKEN_PUBLIC_KEYS: string;
  APP_TOKEN_ISSUER: string;
  APP_TOKEN_AUDIENCE: string;
  /** Comma-separated origins that may call the HTTP routes from a browser. */
  ALLOWED_ORIGINS: string;
}
