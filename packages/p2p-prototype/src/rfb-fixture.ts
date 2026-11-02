import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

/** Minimal RFB 3.8 fixture with a real binary WebSocket and a 2x2 green framebuffer. */
export async function startRfbFixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (ws) => {
    let state = 0;
    let buffer = Buffer.alloc(0);
    ws.send("RFB 003.008\n", { binary: true });
    ws.on("message", (raw) => {
      buffer = Buffer.concat([buffer, Buffer.from(raw as Buffer)]);
      while (buffer.length) {
        if (state === 0) {
          if (buffer.length < 12) return;
          buffer = buffer.subarray(12);
          state = 1;
          ws.send(Buffer.from([1, 1]));
        } else if (state === 1) {
          buffer = buffer.subarray(1);
          state = 2;
          ws.send(Buffer.alloc(4));
        } else if (state === 2) {
          buffer = buffer.subarray(1);
          state = 3;
          const init = Buffer.alloc(24);
          init.writeUInt16BE(2, 0);
          init.writeUInt16BE(2, 2);
          init[4] = 32;
          init[5] = 24;
          init[7] = 1;
          init.writeUInt16BE(255, 8);
          init.writeUInt16BE(255, 10);
          init.writeUInt16BE(255, 12);
          init[14] = 16;
          init[15] = 8;
          const name = Buffer.from("Screen fixture");
          init.writeUInt32BE(name.length, 20);
          ws.send(Buffer.concat([init, name]));
        } else {
          const kind = buffer[0];
          let length = 0;
          if (kind === 0) length = 20;
          else if (kind === 2) {
            if (buffer.length < 4) return;
            length = 4 + 4 * buffer.readUInt16BE(2);
          } else if (kind === 3) length = 10;
          else if (kind === 4) length = 8;
          else if (kind === 5) length = 6;
          else if (kind === 6) {
            if (buffer.length < 8) return;
            length = 8 + buffer.readUInt32BE(4);
          } else {
            ws.close();
            return;
          }
          if (buffer.length < length) return;
          buffer = buffer.subarray(length);
          if (kind === 3) {
            const update = Buffer.alloc(32);
            update.writeUInt16BE(1, 2);
            update.writeUInt16BE(2, 8);
            update.writeUInt16BE(2, 10);
            for (let i = 16; i < 32; i += 4) update[i + 1] = 255;
            ws.send(update);
          }
        }
      }
    });
  });
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
