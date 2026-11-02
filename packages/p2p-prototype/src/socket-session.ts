import type { ChannelFrame } from "./channel-protocol.js";
import { decodeBytes, encodeBytes } from "./channel-protocol.js";

export interface ScreenSocket {
  write(data: Uint8Array): Promise<void>;
  read: AsyncIterable<Uint8Array>;
  close(): void;
}
export type SocketFrame = Extract<
  ChannelFrame,
  { t: "socket-data" | "socket-ack" | "socket-close" }
>;
export const SOCKET_CHUNK_BYTES = 16384;

/** One acknowledged chunk in each direction bounds buffering independently of the video bitrate. */
export function createSocketSession(
  send: (frame: SocketFrame) => void,
  bearer: string,
  id: string,
) {
  let ended = false;
  let chunk: { seq: number; data: Uint8Array } | undefined;
  let wake: (() => void) | undefined;
  let incoming = 0;
  let outgoing = 0;
  let acknowledgement: { seq: number; resolve(): void; reject(error: Error): void } | undefined;
  const end = () => {
    if (ended) return;
    ended = true;
    chunk = undefined;
    acknowledgement?.reject(new Error("screen socket closed"));
    wake?.();
  };
  const socket: ScreenSocket = {
    async write(data) {
      for (let offset = 0; offset < data.length; offset += SOCKET_CHUNK_BYTES) {
        if (ended || acknowledgement) throw new Error("screen socket not writable");
        const seq = outgoing++;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            end();
          }, 10000);
          acknowledgement = {
            seq,
            resolve: () => {
              clearTimeout(timer);
              acknowledgement = undefined;
              resolve();
            },
            reject: (error) => {
              clearTimeout(timer);
              acknowledgement = undefined;
              reject(error);
            },
          };
          try {
            send({
              t: "socket-data",
              bearer,
              id,
              seq,
              data: encodeBytes(data.subarray(offset, offset + SOCKET_CHUNK_BYTES)),
            });
          } catch {
            end();
          }
        });
      }
    },
    read: {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!chunk)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          if (ended || !chunk) continue;
          const next = chunk;
          yield next.data;
          chunk = undefined;
          if (!ended) send({ t: "socket-ack", bearer, id, seq: next.seq });
        }
      },
    },
    close() {
      if (ended) return;
      end();
      send({ t: "socket-close", bearer, id });
    },
  };
  return {
    socket,
    receive(frame: SocketFrame): void {
      if (ended) return;
      if (frame.t === "socket-close") {
        end();
        return;
      }
      if (frame.t === "socket-ack") {
        if (!acknowledgement || frame.seq !== acknowledgement.seq)
          throw new Error("invalid screen acknowledgement");
        acknowledgement.resolve();
      } else {
        const data = decodeBytes(frame.data);
        if (
          chunk ||
          frame.seq !== incoming++ ||
          data.length > SOCKET_CHUNK_BYTES ||
          data.length === 0
        )
          throw new Error("invalid screen chunk");
        chunk = { seq: frame.seq, data };
        wake?.();
      }
    },
    end,
  };
}
