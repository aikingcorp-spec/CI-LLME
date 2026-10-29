import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { isIPv6 } from "node:net";
import { parseArgs } from "node:util";
import type { StunMessage } from "../stun.js";
import {
  ALLOCATE_ERROR,
  ALLOCATE_SUCCESS,
  ATTR_ERROR_CODE,
  ATTR_NONCE,
  ATTR_REALM,
  ATTR_XOR_RELAYED_ADDRESS,
  buildAllocateRequest,
  findAttribute,
  parseErrorCode,
  parseMessage,
  parseXorAddress,
  TRANSACTION_ID_BYTES,
} from "../stun.js";
import { mintTurnCredentials } from "../turn-credentials.js";

const DEFAULT_TURN_PORT = 3478;
const CREDENTIAL_TTL_SECONDS = 60;
const PEER_ID = "probe";
const FIRST_RTO_MS = 500;
const ATTEMPTS = 3;
const EXIT_UNEXPECTED = 1;
const EXIT_NO_RESULT = 2;

const usage =
  "usage: TURN_HOST=... [TURN_PORT=3478] TURN_SECRET_FILE=... turn-allocate-probe.ts (--valid | --expired-seconds N)";
const { values } = parseArgs({
  options: { valid: { type: "boolean", default: false }, "expired-seconds": { type: "string" } },
});
const expiredSeconds =
  values["expired-seconds"] === undefined ? undefined : Number(values["expired-seconds"]);
const host = process.env.TURN_HOST;
const secretFile = process.env.TURN_SECRET_FILE;
const port = Number(process.env.TURN_PORT ?? DEFAULT_TURN_PORT);
if (
  !host ||
  !secretFile ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  values.valid === (expiredSeconds !== undefined) ||
  (expiredSeconds !== undefined && !(Number.isInteger(expiredSeconds) && expiredSeconds > 0))
) {
  console.error(usage);
  process.exit(EXIT_NO_RESULT);
}

// Minting at a past instant yields a username whose expiry is already `expiredSeconds` ago.
const now = Date.now();
const issuedAt =
  expiredSeconds === undefined ? now : now - (expiredSeconds + CREDENTIAL_TTL_SECONDS) * 1000;
const credentials = mintTurnCredentials(
  {
    secret: readFileSync(secretFile, "utf8").trim(),
    urls: [],
    ttlSeconds: CREDENTIAL_TTL_SECONDS,
  },
  PEER_ID,
  issuedAt,
);

const socket = createSocket(isIPv6(host) ? "udp6" : "udp4");

/** Sends the request, retransmitting with doubling timeouts, until a reply with the same transaction id arrives. */
function exchange(request: Buffer, transactionId: Buffer): Promise<StunMessage | undefined> {
  return new Promise((resolve) => {
    let attempt = 0;
    let timer: NodeJS.Timeout | undefined;
    const done = (message?: StunMessage): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      resolve(message);
    };
    const onError = (): void => done();
    const onMessage = (data: Buffer): void => {
      const message = parseMessage(data);
      if (message?.transactionId.equals(transactionId)) done(message);
    };
    const send = (): void => {
      if (attempt === ATTEMPTS) {
        done();
        return;
      }
      socket.send(request, port, host);
      timer = setTimeout(send, FIRST_RTO_MS * 2 ** attempt);
      attempt += 1;
    };
    socket.once("error", onError);
    socket.on("message", onMessage);
    send();
  });
}

const printable = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?");

/** Prints the outcome only: no realm, nonce, password or key. Returns whether it was a success. */
function report(response: StunMessage | undefined): boolean | undefined {
  console.log(`username=${credentials.username}`);
  if (response === undefined) {
    console.log("response=none");
    return undefined;
  }
  if (response.type === ALLOCATE_SUCCESS) {
    const relayed = findAttribute(response, ATTR_XOR_RELAYED_ADDRESS);
    console.log("response=success");
    console.log(`relayed=${relayed && parseXorAddress(relayed, response.transactionId)}`);
    return true;
  }
  const error = findAttribute(response, ATTR_ERROR_CODE);
  const parsed = error && parseErrorCode(error);
  console.log(response.type === ALLOCATE_ERROR ? "response=error" : "response=unexpected");
  if (parsed) console.log(`error=${parsed.code} ${printable(parsed.reason)}`);
  return false;
}

async function probe(): Promise<boolean | undefined> {
  const firstId = randomBytes(TRANSACTION_ID_BYTES);
  const challenge = await exchange(buildAllocateRequest(firstId), firstId);
  const challengeError = challenge && findAttribute(challenge, ATTR_ERROR_CODE);
  if (
    challenge?.type !== ALLOCATE_ERROR ||
    !challengeError ||
    parseErrorCode(challengeError)?.code !== 401
  )
    return report(challenge);
  const realm = challenge && findAttribute(challenge, ATTR_REALM)?.toString();
  const nonce = challenge && findAttribute(challenge, ATTR_NONCE)?.toString();
  if (realm === undefined || nonce === undefined) return report(challenge);

  const secondId = randomBytes(TRANSACTION_ID_BYTES);
  const request = buildAllocateRequest(secondId, {
    username: credentials.username,
    realm,
    nonce,
    password: credentials.credential,
  });
  return report(await exchange(request, secondId));
}

const succeeded = await probe();
socket.close();
if (succeeded === undefined) process.exit(EXIT_NO_RESULT);
// An expired username is expected to be refused; a valid one is expected to be allocated.
process.exit(succeeded === (expiredSeconds === undefined) ? 0 : EXIT_UNEXPECTED);
