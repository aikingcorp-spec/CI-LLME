import { createHash, createHmac } from "node:crypto";

export interface StunAttribute {
  type: number;
  value: Buffer;
}
export interface StunMessage {
  type: number;
  transactionId: Buffer;
  attributes: StunAttribute[];
}
export interface LongTermAuth {
  username: string;
  realm: string;
  nonce: string;
  password: string;
}

export const ATTR_USERNAME = 0x0006;
export const ATTR_MESSAGE_INTEGRITY = 0x0008;
export const ATTR_ERROR_CODE = 0x0009;
export const ATTR_REALM = 0x0014;
export const ATTR_NONCE = 0x0015;
export const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
export const ATTR_REQUESTED_TRANSPORT = 0x0019;
export const ALLOCATE_REQUEST = 0x0003;
export const ALLOCATE_SUCCESS = 0x0103;
export const ALLOCATE_ERROR = 0x0113;

const MAGIC_COOKIE = 0x2112a442;
const HEADER_BYTES = 20;
export const TRANSACTION_ID_BYTES = 12;
const SHA1_BYTES = 20;
const ATTRIBUTE_HEADER_BYTES = 4;
const TRANSPORT_UDP = 17;
const FAMILY_IPV4 = 1;
const FAMILY_IPV6 = 2;

const padded = (n: number): number => (n + 3) & ~3;

/** Type-length-value with the value zero-padded to a 4-byte boundary; the length excludes padding. */
export function encodeAttributes(attributes: StunAttribute[]): Buffer {
  return Buffer.concat(
    attributes.map(({ type, value }) => {
      const out = Buffer.alloc(ATTRIBUTE_HEADER_BYTES + padded(value.length));
      out.writeUInt16BE(type, 0);
      out.writeUInt16BE(value.length, 2);
      value.copy(out, ATTRIBUTE_HEADER_BYTES);
      return out;
    }),
  );
}

export function encodeMessage(
  type: number,
  transactionId: Buffer,
  attributes: StunAttribute[],
): Buffer {
  if (transactionId.length !== TRANSACTION_ID_BYTES)
    throw new Error("invalid transaction id length");
  const body = encodeAttributes(attributes);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
}

/** RFC 5389 long-term credential key: MD5(username:realm:password). */
export const longTermKey = (username: string, realm: string, password: string): Buffer =>
  createHash("md5").update(`${username}:${realm}:${password}`).digest();

/**
 * Appends MESSAGE-INTEGRITY. The HMAC covers everything before the attribute, with the header
 * length already counting the 24-byte attribute (RFC 5389 section 15.4).
 */
export function appendMessageIntegrity(message: Buffer, key: Buffer): Buffer {
  const attributeBytes = ATTRIBUTE_HEADER_BYTES + SHA1_BYTES;
  const counted = Buffer.from(message);
  counted.writeUInt16BE(message.length - HEADER_BYTES + attributeBytes, 2);
  const mac = createHmac("sha1", key).update(counted).digest();
  return Buffer.concat([counted, encodeAttributes([{ type: ATTR_MESSAGE_INTEGRITY, value: mac }])]);
}

export function buildAllocateRequest(transactionId: Buffer, auth?: LongTermAuth): Buffer {
  const text = (type: number, value: string): StunAttribute => ({
    type,
    value: Buffer.from(value),
  });
  // REQUESTED-TRANSPORT: protocol number, then three reserved bytes.
  const attributes: StunAttribute[] = [
    { type: ATTR_REQUESTED_TRANSPORT, value: Buffer.from([TRANSPORT_UDP, 0, 0, 0]) },
  ];
  if (auth === undefined) return encodeMessage(ALLOCATE_REQUEST, transactionId, attributes);
  attributes.push(
    text(ATTR_USERNAME, auth.username),
    text(ATTR_REALM, auth.realm),
    text(ATTR_NONCE, auth.nonce),
  );
  return appendMessageIntegrity(
    encodeMessage(ALLOCATE_REQUEST, transactionId, attributes),
    longTermKey(auth.username, auth.realm, auth.password),
  );
}

export function parseMessage(data: Buffer): StunMessage | undefined {
  if (data.length < HEADER_BYTES || (data[0] ?? 0) >= 0x40 || data.readUInt32BE(4) !== MAGIC_COOKIE)
    return undefined;
  if (data.readUInt16BE(2) !== data.length - HEADER_BYTES) return undefined;
  const attributes: StunAttribute[] = [];
  let offset = HEADER_BYTES;
  while (offset + ATTRIBUTE_HEADER_BYTES <= data.length) {
    const length = data.readUInt16BE(offset + 2);
    const start = offset + ATTRIBUTE_HEADER_BYTES;
    if (start + length > data.length) return undefined;
    attributes.push({
      type: data.readUInt16BE(offset),
      value: data.subarray(start, start + length),
    });
    offset = start + padded(length);
  }
  if (offset !== data.length) return undefined;
  return {
    type: data.readUInt16BE(0),
    transactionId: data.subarray(8, HEADER_BYTES),
    attributes,
  };
}

export const findAttribute = (m: StunMessage, type: number): Buffer | undefined =>
  m.attributes.find((a) => a.type === type)?.value;

/** ERROR-CODE: two reserved bytes, the class (hundreds), the number (0-99), then a UTF-8 reason. */
export function parseErrorCode(value: Buffer): { code: number; reason: string } | undefined {
  if (value.length < 4) return undefined;
  return {
    code: (value.readUInt8(2) & 0x07) * 100 + value.readUInt8(3),
    reason: value.subarray(4).toString("utf8"),
  };
}

/** XOR-MAPPED/RELAYED-ADDRESS: port XOR the cookie's high half, address XOR the cookie (+ transaction id for IPv6). */
export function parseXorAddress(value: Buffer, transactionId: Buffer): string | undefined {
  if (value.length < 4) return undefined;
  const family = value[1];
  const mask = Buffer.alloc(4);
  mask.writeUInt32BE(MAGIC_COOKIE);
  const port = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16);
  const xor = (bytes: Buffer, key: Buffer): number[] =>
    Array.from(bytes, (b, i) => b ^ (key[i] ?? 0));
  if (family === FAMILY_IPV4 && value.length === 8) {
    return `${xor(value.subarray(4, 8), mask).join(".")}:${port}`;
  }
  if (family === FAMILY_IPV6 && value.length === 20) {
    const bytes = Buffer.from(xor(value.subarray(4, 20), Buffer.concat([mask, transactionId])));
    const groups = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16));
    return `[${groups.join(":")}]:${port}`;
  }
  return undefined;
}
