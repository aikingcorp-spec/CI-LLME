import { encodeFrame, decodeGatewayFrame, decodeNodeFrame } from "@rakazo/p2p-prototype/protocol";
import { generateKeyPair, signNodeProof } from "@rakazo/p2p-prototype/pairing";
import { describe, expect, it } from "vitest";
import { Room, type Attachment, type RoomHost, type RoomSocket } from "./room.js";

function harness() {
  let now = 1_800_000_000_000;
  const sockets: FakeSocket[] = [];
  const host: RoomHost = {
    sockets: () => sockets.filter((s) => s.attachment.role !== "gone"),
    now: () => now,
    setAlarm: () => {},
    agentSeen: () => {},
  };
  return { room: new Room(host), sockets, now: () => now };
}

class FakeSocket implements RoomSocket {
  sent: string[] = [];
  closed: Array<[number, string]> = [];
  constructor(public attachment: Attachment) {}
  setAttachment(attachment: Attachment): void { this.attachment = attachment; }
  send(data: string): void { this.sent.push(data); }
  close(code: number, reason: string): void { this.closed.push([code, reason]); }
}

describe("Room", () => {
  it("routes each client's offer/answer exchange with the node without cross-delivery", async () => {
    const h = harness();
    const node = generateKeyPair();
    const agent = new FakeSocket(h.room.admit({ role: "agent", nodeId: "node-1", nodeKey: node.publicKey }) as Attachment);
    h.sockets.push(agent); h.room.open(agent);
    await h.room.message(agent, encodeFrame({ kind: "hello", ...signNodeProof(node, "agent", "node-1", h.now()) }));
    expect(agent.sent.map((x) => decodeGatewayFrame(x))).toContainEqual({ kind: "welcome", nodeId: "node-1" });
    agent.sent.length = 0;

    const a = new FakeSocket(h.room.admit({ role: "signal", nodeId: "node-1", peerId: "peer-a", user: "user-a", exp: h.now() + 60_000 }) as Attachment);
    const b = new FakeSocket(h.room.admit({ role: "signal", nodeId: "node-1", peerId: "peer-b", user: "user-b", exp: h.now() + 60_000 }) as Attachment);
    h.sockets.push(a, b); h.room.open(a); h.room.open(b);

    await h.room.message(a, encodeFrame({ kind: "signal", from: "", to: "node-1", payload: { type: "offer", sdp: "offer-a" } }));
    await h.room.message(b, encodeFrame({ kind: "signal", from: "", to: "node-1", payload: { type: "offer", sdp: "offer-b" } }));
    expect(agent.sent.map((x) => decodeNodeFrame(x))).toEqual([
      { kind: "signal", from: "peer-a", to: "node-1", payload: { type: "offer", sdp: "offer-a" } },
      { kind: "signal", from: "peer-b", to: "node-1", payload: { type: "offer", sdp: "offer-b" } },
    ]);
    agent.sent.length = 0;

    await h.room.message(agent, encodeFrame({ kind: "signal", from: "node-1", to: "peer-a", payload: { type: "answer", sdp: "answer-a" } }));
    expect(a.sent.map((x) => decodeNodeFrame(x))).toEqual([
      { kind: "signal", from: "node-1", to: "peer-a", payload: { type: "answer", sdp: "answer-a" } },
    ]);
    expect(b.sent).toHaveLength(0);

    await h.room.message(agent, encodeFrame({ kind: "signal", from: "node-1", to: "peer-b", payload: { type: "answer", sdp: "answer-b" } }));
    expect(b.sent.map((x) => decodeNodeFrame(x))).toEqual([
      { kind: "signal", from: "node-1", to: "peer-b", payload: { type: "answer", sdp: "answer-b" } },
    ]);
    expect(a.sent).toHaveLength(1);
  });

  it("closes a client that targets another client", async () => {
    const h = harness();
    const client = new FakeSocket(h.room.admit({ role: "signal", nodeId: "node-1", peerId: "peer-a", user: "user-a", exp: h.now() + 60_000 }) as Attachment);
    h.sockets.push(client); h.room.open(client);

    await h.room.message(client, encodeFrame({ kind: "signal", from: "", to: "peer-b", payload: { type: "offer", sdp: "forbidden" } }));

    expect(client.closed).toContainEqual([1008, "forbidden target"]);
  });
});
