import { describe, expect, it } from "vitest";
import type { SignalPayload } from "./protocol.js";
import { connectPeer } from "./webrtc-peer.js";
import { WeriftPeerConnection, weriftIceServers } from "./werift-peer-connection.js";

function linkedSignaling() {
  const listeners: Record<string, ((payload: SignalPayload) => void) | undefined> = {};
  const side = (self: string, other: string) => ({
    send: (payload: SignalPayload) => queueMicrotask(() => listeners[other]?.(payload)),
    listen: (receive: (payload: SignalPayload) => void) => {
      listeners[self] = receive;
      return () => {
        listeners[self] = undefined;
      };
    },
  });
  return { a: side("a", "b"), b: side("b", "a") };
}

describe("weriftIceServers", () => {
  const base = { hostname: "203.0.113.5", username: "u", password: "p" };
  it("maps each relay type to the werift URL that selects its client transport", () => {
    expect(
      weriftIceServers([
        { ...base, port: 3479, relayType: "TurnUdp" },
        { ...base, port: 3479, relayType: "TurnTcp" },
        { ...base, port: 5350, relayType: "TurnTls" },
      ]),
    ).toEqual([
      { urls: "turn:203.0.113.5:3479?transport=udp", username: "u", credential: "p" },
      { urls: "turn:203.0.113.5:3479?transport=tcp", username: "u", credential: "p" },
      { urls: "turns:203.0.113.5:5350?transport=tcp", username: "u", credential: "p" },
    ]);
  });
  it("rejects strings and servers without credentials", () => {
    expect(() => weriftIceServers(["stun:203.0.113.5:3478"])).toThrow(/IceServer objects/);
    expect(() => weriftIceServers([{ hostname: "h", port: 1, relayType: "TurnTcp" }])).toThrow(
      /credential/,
    );
  });
});

describe("WeriftPeerConnection through connectPeer", () => {
  it("opens a data channel, exchanges messages both ways and closes with BYE/BYE_ACK", async () => {
    const link = linkedSignaling();
    const make = (name: string) => new WeriftPeerConnection(name, { iceServers: [] });
    const created: WeriftPeerConnection[] = [];
    const createPeerConnection = (name: string) => {
      const pc = make(name);
      created.push(pc);
      return pc;
    };
    const responder = await connectPeer({
      signalUrl: "unused",
      signaling: link.b,
      selfId: "b",
      remoteId: "a",
      initiator: false,
      createPeerConnection,
    });
    const initiator = await connectPeer({
      signalUrl: "unused",
      signaling: link.a,
      selfId: "a",
      remoteId: "b",
      initiator: true,
      createPeerConnection,
    });
    await Promise.all([initiator.open, responder.open]);

    initiator.send("ping");
    responder.send("pong");
    const [atResponder, atInitiator] = await Promise.all([
      responder.messages[Symbol.asyncIterator]().next(),
      initiator.messages[Symbol.asyncIterator]().next(),
    ]);
    expect(atResponder.value).toBe("ping");
    expect(atInitiator.value).toBe("pong");
    expect(initiator.selectedPair()?.local).toContain("typ host");
    expect(created[1]?.selectedTurnTransport()).toBeUndefined();

    await initiator.closeGracefully();
    expect(initiator.isClosed()).toBe(true);
    const end = await responder.messages[Symbol.asyncIterator]().next();
    expect(end.done).toBe(true);
    responder.close();
  }, 20_000);
});
