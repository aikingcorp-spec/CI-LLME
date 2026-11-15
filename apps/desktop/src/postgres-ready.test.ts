import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { afterEach, expect, it } from "vitest";
import { postgresReady } from "./postgres-ready.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function errorResponse(code: string): Buffer {
  const body = Buffer.from(`SFATAL\0C${code}\0Mmessage\0\0`, "utf8");
  const header = Buffer.alloc(5);
  header.write("E", 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

async function answering(reply: Buffer): Promise<number> {
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(reply));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

it("is ready once the server asks for authentication", async () => {
  expect(await postgresReady(await answering(Buffer.from("R\0\0\0\x08\0\0\0\x05", "binary")))).toBe(
    true,
  );
});

it("is ready when the server refuses this login, as pg_isready reports", async () => {
  expect(await postgresReady(await answering(errorResponse("28000")))).toBe(true);
});

it("is not ready while the server is starting up", async () => {
  expect(await postgresReady(await answering(errorResponse("57P03")))).toBe(false);
});

it("is not ready when nothing listens", async () => {
  const port = await answering(Buffer.alloc(0));
  await new Promise((done) => servers.pop()!.close(done));
  expect(await postgresReady(port)).toBe(false);
});
