import type { ChannelFrame } from "./channel-protocol.js";
import { decodeChannelFrame } from "./channel-protocol.js";

// JSON escaping and UTF-8 expansion still keep each fragment below SCTP's 64 KiB floor.
const FRAGMENT_LENGTH = 8192;
const UNFRAGMENTED_LENGTH = 16384;
const MAX_FRAME_LENGTH = 8 * 1024 * 1024;

/** Ordered, reliable SCTP lets one bounded frame be reassembled without multiplexing buffers. */
export function createChannelFraming(sendRaw: (text: string) => void) {
  let bearer: string | undefined;
  let parts: string[] = [];
  let received = 0;
  let total = 0;
  return {
    enable(authenticatedBearer: string): void {
      bearer = authenticatedBearer;
    },
    send(frame: ChannelFrame): void {
      const raw = JSON.stringify(frame);
      if (raw.length > MAX_FRAME_LENGTH) throw new Error("channel frame too large");
      if (raw.length <= UNFRAGMENTED_LENGTH) {
        sendRaw(raw);
        return;
      }
      if (!bearer) throw new Error("peer requires fragmentation support");
      for (let offset = 0; offset < raw.length; offset += FRAGMENT_LENGTH)
        sendRaw(
          JSON.stringify({
            t: "fragment",
            bearer,
            total: raw.length,
            offset,
            data: raw.slice(offset, offset + FRAGMENT_LENGTH),
          }),
        );
    },
    receive(raw: string): ChannelFrame | undefined {
      if (raw.length > MAX_FRAME_LENGTH) throw new Error("channel frame too large");
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && "t" in value && value.t === "fragment") {
        const f = value as Record<string, unknown>;
        if (
          !bearer ||
          f.bearer !== bearer ||
          !Number.isInteger(f.total) ||
          (f.total as number) <= UNFRAGMENTED_LENGTH ||
          (f.total as number) > MAX_FRAME_LENGTH ||
          f.offset !== received ||
          (received > 0 && f.total !== total) ||
          typeof f.data !== "string" ||
          f.data.length === 0 ||
          f.data.length !== Math.min(FRAGMENT_LENGTH, (f.total as number) - received)
        )
          throw new Error("invalid channel fragment");
        total = f.total as number;
        parts.push(f.data);
        received += f.data.length;
        if (received < total) return;
        const frame = decodeChannelFrame(parts.join(""));
        parts = [];
        received = total = 0;
        if (!("bearer" in frame) || frame.bearer !== bearer)
          throw new Error("invalid fragmented bearer");
        return frame;
      }
      if (received > 0) throw new Error("incomplete channel frame");
      return decodeChannelFrame(raw);
    },
  };
}
