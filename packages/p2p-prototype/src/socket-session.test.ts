import { expect, it, vi } from "vitest";
import type { SocketFrame } from "./socket-session.js";
import { createSocketSession } from "./socket-session.js";

it("bounds chunks and applies backpressure until each chunk is consumed", async () => {
  const wire: SocketFrame[] = [];
  const sender = createSocketSession(
    (f) => {
      wire.push(f);
      receiver.receive(f);
    },
    "fixture",
    "socket",
  );
  const receiver = createSocketSession((f) => sender.receive(f), "fixture", "socket");
  const bytes = new Uint8Array(40000).fill(42);
  const sent = sender.socket.write(bytes);
  const input = receiver.socket.read[Symbol.asyncIterator]();
  const first = await input.next();
  expect(first.value).toHaveLength(16384);
  expect(wire).toHaveLength(1);
  const second = await input.next();
  expect(second.value).toHaveLength(16384);
  const third = await input.next();
  expect(third.value).toHaveLength(7232);
  const end = input.next();
  await sent;
  sender.socket.close();
  expect((await end).done).toBe(true);
});
it("rejects unsolicited acknowledgements and data beyond its receive window", () => {
  const session = createSocketSession(() => {}, "fixture", "socket");
  expect(() =>
    session.receive({ t: "socket-ack", bearer: "fixture", id: "socket", seq: 0 }),
  ).toThrow();
  const f = { t: "socket-data" as const, bearer: "fixture", id: "socket", seq: 0, data: "AA==" };
  session.receive(f);
  expect(() => session.receive({ ...f, seq: 1 })).toThrow();
  session.end();
});
it("terminates stalled sends and wakes readers on revocation", async () => {
  vi.useFakeTimers();
  try {
    const session = createSocketSession(() => {}, "fixture", "socket");
    const read = session.socket.read[Symbol.asyncIterator]().next();
    const send = session.socket.write(new Uint8Array([1]));
    const rejected = expect(send).rejects.toThrow("closed");
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect((await read).done).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
