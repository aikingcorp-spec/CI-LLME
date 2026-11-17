import { connect } from "node:net";

/** SQLSTATE 57P03: the server is starting up, shutting down, or in recovery. */
const CANNOT_CONNECT_NOW = "57P03";

/**
 * Whether PostgreSQL on this loopback port accepts sessions, answered the way `pg_isready`
 * answers it: any reply to a startup message except "cannot connect now" means ready, because
 * a refused login still proves the server is serving. The relocatable builds the app ships on
 * macOS and Windows do not include `pg_isready`.
 */
export function postgresReady(port: number, signal?: AbortSignal, timeoutMs = 2_000) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    let reply = Buffer.alloc(0);
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.once("connect", () => socket.write(startupMessage()));
    socket.on("data", (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      const type = String.fromCharCode(reply[0] ?? 0);
      if (type !== "E") {
        finish(true);
        return;
      }
      if (reply.length < 5) return;
      const length = reply.readInt32BE(1);
      if (reply.length < length + 1) return;
      finish(errorCode(reply.subarray(5, length + 1)) !== CANNOT_CONNECT_NOW);
    });
  });
}

function startupMessage(): Buffer {
  const parameters = Buffer.from("user\0postgres\0database\0postgres\0\0", "utf8");
  const message = Buffer.alloc(8 + parameters.length);
  message.writeInt32BE(message.length, 0);
  message.writeInt32BE(196_608, 4); // protocol 3.0
  parameters.copy(message, 8);
  return message;
}

/** The `C` field of an ErrorResponse body. */
function errorCode(body: Buffer): string | undefined {
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const end = body.indexOf(0, offset + 1);
    if (end < 0) return undefined;
    if (String.fromCharCode(body[offset]!) === "C") return body.toString("utf8", offset + 1, end);
    offset = end + 1;
  }
  return undefined;
}
