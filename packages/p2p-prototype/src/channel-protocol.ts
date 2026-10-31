/** JSON text frames. Every authenticated frame carries the channel's node bearer. */
export type ChannelFrame =
  | { t: "hello"; assertion: string }
  | { t: "denied" }
  | { t: "welcome"; bearer: string }
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
  if (v.t === "hello") return { t: v.t, assertion: str("assertion") };
  if (v.t === "denied") return { t: v.t };
  const bearer = str("bearer");
  if (v.t === "welcome") return { t: v.t, bearer };
  const id = str("id");
  switch (v.t) {
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
