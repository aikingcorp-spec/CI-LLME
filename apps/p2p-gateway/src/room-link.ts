import type { Admission } from "./room.js";

/**
 * How the Worker tells a NodeRoom who is connecting. The Worker has already authenticated the
 * caller and the object is not reachable from outside, so these headers are trusted; the Worker
 * clears any it receives (`withAdmission`).
 */
const HEADER = {
  role: "x-room-role",
  nodeId: "x-room-node-id",
  nodeKey: "x-room-node-key",
  peerId: "x-room-peer-id",
  user: "x-room-user",
  exp: "x-room-exp",
} as const;

/** The request to forward to the room: the caller's upgrade headers, minus credentials, plus the admission. */
export function withAdmission(request: Request, admission: Admission): Request {
  const forwarded = new Request(request);
  for (const name of [...Object.values(HEADER), "authorization", "cookie"]) {
    forwarded.headers.delete(name);
  }
  const set = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) forwarded.headers.set(name, String(value));
  };
  set(HEADER.role, admission.role);
  set(HEADER.nodeId, admission.nodeId);
  if (admission.role === "agent") set(HEADER.nodeKey, admission.nodeKey);
  else {
    set(HEADER.peerId, admission.peerId);
    set(HEADER.user, admission.user);
    set(HEADER.exp, admission.exp);
  }
  return forwarded;
}

export function admissionOf(h: Headers): Admission | undefined {
  const nodeId = h.get(HEADER.nodeId);
  if (!nodeId) return undefined;
  if (h.get(HEADER.role) === "agent") {
    const nodeKey = h.get(HEADER.nodeKey);
    return nodeKey ? { role: "agent", nodeId, nodeKey } : undefined;
  }
  const peerId = h.get(HEADER.peerId);
  if (h.get(HEADER.role) !== "signal" || !peerId) return undefined;
  const user = h.get(HEADER.user);
  if (user === null) return { role: "signal", nodeId, peerId };
  const exp = Number(h.get(HEADER.exp));
  return Number.isFinite(exp) ? { role: "signal", nodeId, peerId, user, exp } : undefined;
}
