export type NodeId = string;
export type RelayRequest = {
  kind: "request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};
export type RelayResponse = {
  kind: "response";
  id: string;
  status: number;
  headers: Record<string, string>;
  body: string;
};
export type Hello = { kind: "hello"; nodeId: NodeId; ts: number; sig: string };
export type Welcome = { kind: "welcome"; nodeId: NodeId };
export type SignalPayload =
  | { type: "offer" | "answer"; sdp: string }
  | { type: "candidate"; candidate: string; mid: string };
export type Signal = { kind: "signal"; from: string; to: string; payload: SignalPayload };
export type NodeFrame = Hello | RelayResponse | Signal;
export type RelayCancel = { kind: "cancel"; id: string };
export type GatewayFrame = Welcome | RelayRequest | RelayCancel | Signal;

type Fields = Record<string, unknown>;

function fail(what: string): never {
  throw new Error(`invalid frame: ${what}`);
}

function isFields(v: unknown): v is Fields {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Fields, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : fail(`${key} must be a string`);
}

function status(o: Fields): number {
  const v = o.status;
  return typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599
    ? v
    : fail("status must be an HTTP status code");
}

function timestamp(o: Fields): number {
  const v = o.ts;
  return typeof v === "number" && Number.isSafeInteger(v) ? v : fail("ts must be an integer");
}

function headers(o: Fields): Record<string, string> {
  const v = o.headers;
  if (!isFields(v)) fail("headers must be an object");
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = typeof val === "string" ? val : fail(`header ${k} must be a string`);
  }
  return out;
}

function payload(o: Fields): SignalPayload {
  const p = o.payload;
  if (!isFields(p)) fail("payload must be an object");
  if (p.type === "offer" || p.type === "answer") return { type: p.type, sdp: str(p, "sdp") };
  if (p.type === "candidate") {
    return { type: "candidate", candidate: str(p, "candidate"), mid: str(p, "mid") };
  }
  return fail("unknown payload type");
}

function decodeFrame(raw: string): NodeFrame | GatewayFrame {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return fail("not JSON");
  }
  if (!isFields(v)) return fail("not an object");
  switch (v.kind) {
    case "cancel":
      return { kind: "cancel", id: str(v, "id") };
    case "request":
      return {
        kind: "request",
        id: str(v, "id"),
        method: str(v, "method"),
        path: str(v, "path"),
        headers: headers(v),
        body: str(v, "body"),
      };
    case "response":
      return {
        kind: "response",
        id: str(v, "id"),
        status: status(v),
        headers: headers(v),
        body: str(v, "body"),
      };
    case "hello":
      return { kind: "hello", nodeId: str(v, "nodeId"), ts: timestamp(v), sig: str(v, "sig") };
    case "welcome":
      return { kind: "welcome", nodeId: str(v, "nodeId") };
    case "signal":
      return { kind: "signal", from: str(v, "from"), to: str(v, "to"), payload: payload(v) };
    default:
      return fail("unknown kind");
  }
}

export function encodeFrame(f: NodeFrame | GatewayFrame): string {
  return JSON.stringify(f);
}

export function decodeNodeFrame(raw: string): NodeFrame {
  const f = decodeFrame(raw);
  return f.kind === "welcome" || f.kind === "request" || f.kind === "cancel"
    ? fail(`${f.kind} is not a node frame`)
    : f;
}

export function decodeGatewayFrame(raw: string): GatewayFrame {
  const f = decodeFrame(raw);
  return f.kind === "hello" || f.kind === "response" ? fail(`${f.kind} is not a gateway frame`) : f;
}

export function toWsUrl(url: string): string {
  return url.replace(/^http/, "ws");
}
