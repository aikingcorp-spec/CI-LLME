import { describe, expect, it } from "vitest";
import {
  ALLOCATE_ERROR,
  ATTR_ERROR_CODE,
  ATTR_USERNAME,
  ATTR_XOR_RELAYED_ADDRESS,
  appendMessageIntegrity,
  buildAllocateRequest,
  encodeAttributes,
  encodeMessage,
  findAttribute,
  longTermKey,
  parseErrorCode,
  parseMessage,
  parseXorAddress,
} from "./stun.js";

const hex = (h: string): Buffer => Buffer.from(h.replace(/\s/g, ""), "hex");

// RFC 5769 section 2.1 request up to and including USERNAME ("evtj:h6vY", padded with spaces).
const RFC5769_BEFORE_INTEGRITY = hex(
  `0001 0038 2112a442 b7e7a701bc34d686fa87dfae
   80220010 5354554e207465737420636c69656e74
   00240004 6e0001ff
   80290008 932ff9b151263b36
   00060009 6576746a3a68367659 202020`,
);
const RFC5769_PASSWORD = Buffer.from("VOkJxbRl1RmTxUk/WvJxBt");
const RFC5769_INTEGRITY = "9aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2";

const TX = hex("000102030405060708090a0b");

describe("stun encoding", () => {
  it("pads attribute values to 4 bytes without counting the padding in the length", () => {
    const out = encodeAttributes([{ type: ATTR_USERNAME, value: Buffer.from("evtj:h6vY") }]);
    expect(out.toString("hex")).toBe("00060009" + "6576746a3a68367659" + "000000");
    expect(out.length % 4).toBe(0);
  });

  it("adds MESSAGE-INTEGRITY with the length counting the attribute (RFC 5769 vector)", () => {
    const out = appendMessageIntegrity(RFC5769_BEFORE_INTEGRITY, RFC5769_PASSWORD);

    const attrStart = RFC5769_BEFORE_INTEGRITY.length;
    expect(out.readUInt16BE(2)).toBe(out.length - 20);
    expect(out.readUInt16BE(2)).toBe(0x50);
    expect(out.readUInt16BE(attrStart)).toBe(0x0008);
    expect(out.readUInt16BE(attrStart + 2)).toBe(20);
    expect(out.subarray(attrStart + 4).toString("hex")).toBe(RFC5769_INTEGRITY);
  });

  it("builds the unauthenticated Allocate request", () => {
    expect(buildAllocateRequest(TX).toString("hex")).toBe(
      "000300082112a442000102030405060708090a0b0019000411000000",
    );
  });

  it("builds the authenticated Allocate request (vector computed independently)", () => {
    const out = buildAllocateRequest(TX, {
      username: "1700000600:probe",
      realm: "example.org",
      nonce: "f//499k954d6OL34oL9FSTvy64sA",
      password: "pw",
    });

    expect(out.toString("hex")).toBe(
      "000300642112a442000102030405060708090a0b" +
        "0019000411000000" +
        "00060010313730303030303630303a70726f6265" +
        "0014000b6578616d706c652e6f726700" +
        "0015001c662f2f3439396b39353464364f4c33346f4c394653547679363473" +
        "41" +
        "00080014e1008942d68f90bee3037cd8e8df3fbd43ee3f5c",
    );
    expect(out.readUInt16BE(2)).toBe(out.length - 20);
  });

  it("derives the long-term key as MD5(username:realm:password)", () => {
    expect(longTermKey("user", "realm", "pass").toString("hex")).toBe(
      "8493fbc53ba582fb4c044c456bdc40eb",
    );
  });
});

describe("stun decoding", () => {
  it("round-trips a message and rejects a wrong length or cookie", () => {
    const wire = encodeMessage(ALLOCATE_ERROR, TX, [
      { type: ATTR_ERROR_CODE, value: Buffer.from([0, 0, 4, 1, 0x55, 0x6e, 0x61]) },
    ]);
    const parsed = parseMessage(wire);

    expect(parsed?.type).toBe(ALLOCATE_ERROR);
    expect(parsed?.transactionId.equals(TX)).toBe(true);
    const error = parsed && findAttribute(parsed, ATTR_ERROR_CODE);
    expect(error && parseErrorCode(error)).toEqual({ code: 401, reason: "Una" });
    expect(parseMessage(wire.subarray(0, wire.length - 1))).toBeUndefined();
    const badCookie = Buffer.from(wire);
    badCookie.writeUInt32BE(1, 4);
    expect(parseMessage(badCookie)).toBeUndefined();
  });

  it("decodes XOR-RELAYED-ADDRESS for IPv4 (RFC 5769 section 2.2 value)", () => {
    // 192.0.2.1:32853 from the RFC's sample response.
    const wire = encodeMessage(0x0101, TX, [
      { type: ATTR_XOR_RELAYED_ADDRESS, value: hex("0001a147e112a643") },
    ]);
    const parsed = parseMessage(wire);
    const value = parsed && findAttribute(parsed, ATTR_XOR_RELAYED_ADDRESS);

    expect(value && parseXorAddress(value, TX)).toBe("192.0.2.1:32853");
  });
});
