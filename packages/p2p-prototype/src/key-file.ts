import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KeyPair } from "./pairing.js";
import { isPublicKey } from "./pairing.js";

/** What a node keeps after pairing: its key pair, the pinned gateway key and the paired user. */
export interface NodeKeyFile extends KeyPair {
  nodeId?: string;
  localUser?: string;
  gatewayPublicKey?: string;
  user?: string;
}

const PRIVATE_MODE = 0o600;

export function readKeyFile(path: string): NodeKeyFile | undefined {
  if (!existsSync(path)) return undefined;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  const f = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  if (typeof f.publicKey !== "string" || typeof f.privateKey !== "string") {
    throw new Error(`${path} is not a key file`);
  }
  if (!isPublicKey(f.publicKey)) throw new Error(`${path} holds an invalid public key`);
  return {
    nodeId: typeof f.nodeId === "string" ? f.nodeId : undefined,
    localUser: typeof f.localUser === "string" ? f.localUser : undefined,
    publicKey: f.publicKey,
    privateKey: f.privateKey,
    gatewayPublicKey: typeof f.gatewayPublicKey === "string" ? f.gatewayPublicKey : undefined,
    user: typeof f.user === "string" ? f.user : undefined,
  };
}

/** Writes the file owner-only; the mode is forced afterwards in case the file already existed. */
export function writeKeyFile(path: string, file: NodeKeyFile): void {
  writeFileSync(path, `${JSON.stringify(file)}\n`, { mode: PRIVATE_MODE });
  chmodSync(path, PRIVATE_MODE);
}
