/** JSON text frames. Every authenticated frame carries the channel's node bearer. */
export type ChannelFrame =
  | { t: "hello"; assertion: string; fragmentation?: true }
  | { t: "denied" }
  | { t: "welcome"; bearer: string; fragmentation?: true; screen?: true }
  | { t: "renew"; bearer: string; id: string; assertion: string }
  | { t: "renewed"; bearer: string; id: string }
  | { t: "socket-open"; bearer: string; id: string; path: string }
  | { t: "socket-opened"; bearer: string; id: string }
  | { t: "socket-close"; bearer: string; id: string }
  | { t: "socket-data"; bearer: string; id: string; seq: number; data: string }
  | { t: "socket-ack"; bearer: string; id: string; seq: number }
  | {
      t: "call" | "subscribe";
      bearer: string;
      id: string;
      procedure: string;
      headers: Record<string, string>;
      body: string;
    }
  | {
      t: "response";
      bearer: string;
      id: string;
      status: number;
      headers: Record<string, string>;
      body: string;
    }
  | { t: "chunk"; bearer: string; id: string; data: string }
  | { t: "end" | "cancel"; bearer: string; id: string }
  | { t: "error"; bearer: string; id: string; message: string };

export const encodeBytes = (body: Uint8Array): string =>
  btoa(Array.from(body, (byte) => String.fromCharCode(byte)).join(""));
export const decodeBytes = (body: string): Uint8Array =>
  Uint8Array.from(atob(body), (char) => char.charCodeAt(0));

export function decodeChannelFrame(raw: string): ChannelFrame {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid frame");
  const v = value as Record<string, unknown>;
  const str = (key: string): string => {
    const s = v[key];
    if (typeof s !== "string") throw new Error(`invalid ${key}`);
    return s;
  };
  const bytes = (key: string): string => {
    const s = str(key);
    if (encodeBytes(decodeBytes(s)) !== s) throw new Error("invalid base64");
    return s;
  };
  const headers = (): Record<string, string> => {
    if (!v.headers || typeof v.headers !== "object" || Array.isArray(v.headers))
      throw new Error("invalid headers");
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.headers)) {
      if (typeof val !== "string") throw new Error("invalid header");
      Object.defineProperty(out, k, { value: val, enumerable: true });
    }
    return out;
  };
  const fragmentation = v.fragmentation === true ? { fragmentation: true as const } : {};
  if (v.t === "hello") return { t: v.t, assertion: str("assertion"), ...fragmentation };
  if (v.t === "denied") return { t: v.t };
  const bearer = str("bearer");
  if (v.t === "welcome")
    return {
      t: v.t,
      bearer,
      ...fragmentation,
      ...(v.screen === true ? { screen: true as const } : {}),
    };
  const id = str("id");
  switch (v.t) {
    case "socket-open":
      return { t: v.t, bearer, id, path: str("path") };
    case "socket-opened":
    case "socket-close":
      return { t: v.t, bearer, id };
    case "socket-data":
    case "socket-ack":
      if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 0)
        throw new Error("invalid socket sequence");
      return v.t === "socket-data"
        ? { t: v.t, bearer, id, seq: v.seq as number, data: bytes("data") }
        : { t: v.t, bearer, id, seq: v.seq as number };
    case "renew":
      return { t: v.t, bearer, id, assertion: str("assertion") };
    case "renewed":
      return { t: v.t, bearer, id };
    case "call":
    case "subscribe":
      return {
        t: v.t,
        bearer,
        id,
        procedure: str("procedure"),
        headers: headers(),
        body: bytes("body"),
      };
    case "response":
      if (
        typeof v.status !== "number" ||
        !Number.isInteger(v.status) ||
        v.status < 100 ||
        v.status > 599
      )
        throw new Error("invalid status");
      return { t: v.t, bearer, id, status: v.status, headers: headers(), body: bytes("body") };
    case "chunk":
      return { t: v.t, bearer, id, data: bytes("data") };
    case "cancel":
    case "end":
      return { t: v.t, bearer, id };
    case "error":
      return { t: v.t, bearer, id, message: str("message") };
    default:
      throw new Error("invalid frame type");
  }
}
