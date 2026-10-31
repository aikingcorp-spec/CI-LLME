import type { NodeFrame } from "@rakazo/p2p-prototype/protocol";
import { decodeNodeFrame, encodeFrame } from "@rakazo/p2p-prototype/protocol";
import { verifyNodeProof } from "./pairing.js";

/*
 * Signaling for one node: its /agent socket and the /signal sockets of the peers that talk to it.
 * Pure logic over a RoomHost, so it runs under unit tests with fakes. The Durable Object
 * (node-room.ts) supplies hibernatable sockets, so every fact lives in socket attachments and
 * nothing here survives eviction except the short signal queue.
 */

export const CLOSE_NORMAL = 1000;
export const CLOSE_BAD_FRAME = 1003;
export const CLOSE_FORBIDDEN_TARGET = 1008;
export const CLOSE_UNAUTHORIZED = 4401;
export const HELLO_TIMEOUT_MS = 5_000;
const MAX_PENDING_SIGNALS = 32;
const DEFAULT_PENDING_SIGNAL_TTL_MS = 15_000;

export type Attachment =
  /** Connected, waiting for a `hello` signed by `nodeKey`. */
  | { role: "agent"; nodeId: string; nodeKey: string; deadline: number }
  /** The node proved its key; its `welcome` is sent. */
  | { role: "agent"; nodeId: string; ready: true }
  /** `user` and `exp` are set for a client, whose assertion ends at `exp`; a node peer has neither. */
  | { role: "signal"; nodeId: string; peerId: string; user?: string; exp?: number }
  /** Replaced by a newer socket and closed. It takes no part in routing. */
  | { role: "gone" };

export type Admission =
  | { role: "agent"; nodeId: string; nodeKey: string }
  | { role: "signal"; nodeId: string; peerId: string; user?: string; exp?: number };

export interface RoomSocket {
  readonly attachment: Attachment;
  setAttachment(attachment: Attachment): void;
  send(data: string): void;
  close(code: number, reason: string): void;
}
export interface RoomHost {
  /** Every accepted socket that has not closed. */
  sockets(): RoomSocket[];
  now(): number;
  /** Wakes the room at that time to run `sweep`; null cancels. */
  setAlarm(atMs: number | null): void;
  /** The agent connected or disconnected: record when the node was last seen. */
  agentSeen(nodeId: string, atMs: number): void;
}

interface QueuedSignal {
  from: string;
  raw: string;
  expiresAt: number;
}

type SignalAttachment = Extract<Attachment, { role: "signal" }>;
type SignalSocket = RoomSocket & { readonly attachment: SignalAttachment };

const ownerOf = (a: { nodeId: string; user?: string }): string =>
  a.user !== undefined ? `user:${a.user}` : `node:${a.nodeId}`;

export class Room {
  // A signal for an offline peer belongs to a session that may already be dead; a stale offer or
  // candidate delivered to the next session's responder breaks ICE, hence the short lifetime.
  // It is lost if the object is evicted before the peer arrives.
  private readonly queued = new Map<string, QueuedSignal[]>();

  constructor(
    private readonly host: RoomHost,
    private readonly pendingSignalTtlMs = DEFAULT_PENDING_SIGNAL_TTL_MS,
  ) {}

  /** Decides whether a socket may join and returns the attachment it starts with. */
  admit(admission: Admission): Attachment | { status: 409 } {
    if (admission.role === "agent") {
      const { nodeId, nodeKey } = admission;
      return { role: "agent", nodeId, nodeKey, deadline: this.host.now() + HELLO_TIMEOUT_MS };
    }
    const holder = this.signalSockets().find((s) => s.attachment.peerId === admission.peerId);
    if (holder !== undefined && ownerOf(holder.attachment) !== ownerOf(admission)) {
      return { status: 409 };
    }
    return admission;
  }

  /** Called once the socket is accepted and carries the attachment from `admit`. */
  open(sock: RoomSocket): void {
    const a = sock.attachment;
    if (a.role === "signal") {
      for (const other of this.signalSockets()) {
        if (other !== sock && other.attachment.peerId === a.peerId) this.replace(other);
      }
      this.flush(a.peerId, sock);
    }
    this.schedule();
  }

  async message(sock: RoomSocket, data: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof data !== "string") throw new Error("binary frame");
      const a = sock.attachment;
      if (a.role === "agent" && "nodeKey" in a) await this.hello(sock, a, data);
      else if (a.role === "agent") this.relay(a.nodeId, a.nodeId, decodeNodeFrame(data));
      else if (a.role === "signal") this.clientFrame(sock, a, data);
    } catch {
      sock.close(CLOSE_BAD_FRAME, "bad frame");
    }
  }

  close(sock: RoomSocket): void {
    const a = sock.attachment;
    if (a.role === "agent" && "ready" in a) this.host.agentSeen(a.nodeId, this.host.now());
    if (a.role === "signal") this.dropSignalsFrom(a.peerId);
    this.schedule();
  }

  online(): boolean {
    return this.readyAgent() !== undefined;
  }

  /** The node was unpaired: end every connection. */
  kick(): void {
    for (const sock of this.host.sockets()) {
      if (sock.attachment.role !== "gone") sock.close(CLOSE_UNAUTHORIZED, "unpaired");
    }
    this.queued.clear();
  }

  /** Alarm: end expired assertions and silent connections, then plan the next wake-up. */
  sweep(): void {
    const now = this.host.now();
    for (const sock of this.host.sockets()) {
      const a = sock.attachment;
      if (a.role === "agent" && "deadline" in a && a.deadline <= now) {
        sock.close(CLOSE_UNAUTHORIZED, "hello timeout");
      } else if (a.role === "signal" && a.exp !== undefined && a.exp <= now) {
        sock.close(CLOSE_UNAUTHORIZED, "assertion expired");
      }
    }
    this.schedule();
  }

  private async hello(
    sock: RoomSocket,
    a: Extract<Attachment, { nodeKey: string }>,
    data: string,
  ): Promise<void> {
    const frame = decodeNodeFrame(data);
    // Unknown, revoked and badly signed nodes all fail the same way.
    if (
      frame.kind !== "hello" ||
      frame.nodeId !== a.nodeId ||
      !(await verifyNodeProof(a.nodeKey, "agent", frame, this.host.now()))
    ) {
      sock.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    for (const other of this.host.sockets()) {
      if (other !== sock && other.attachment.role === "agent" && "ready" in other.attachment) {
        this.replace(other);
      }
    }
    sock.setAttachment({ role: "agent", nodeId: a.nodeId, ready: true });
    sock.send(encodeFrame({ kind: "welcome", nodeId: a.nodeId }));
    this.host.agentSeen(a.nodeId, this.host.now());
    this.flush(a.nodeId, sock);
    this.schedule();
  }

  // A client may only signal the node its assertion names; a node may answer any peer.
  private clientFrame(
    sock: RoomSocket,
    a: SignalAttachment,
    data: string,
  ): void {
    const isClient = a.user !== undefined;
    if (isClient && (a.exp ?? 0) <= this.host.now()) {
      sock.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    const frame = decodeNodeFrame(data);
    if (isClient && frame.kind === "signal" && frame.to !== a.nodeId) {
      sock.close(CLOSE_FORBIDDEN_TARGET, "forbidden target");
      return;
    }
    this.relay(a.peerId, a.nodeId, frame);
  }

  private relay(from: string, nodeId: string, frame: NodeFrame): void {
    if (frame.kind === "signal") this.deliver(from, frame.to, encodeFrame({ ...frame, from }), nodeId);
  }

  private deliver(from: string, to: string, raw: string, nodeId: string): void {
    // Prefer a dedicated signaling peer; otherwise wake the node agent.
    const target =
      this.signalSockets().find((s) => s.attachment.peerId === to) ??
      (to === nodeId ? this.readyAgent() : undefined);
    if (target !== undefined) {
      try {
        target.send(raw);
        return;
      } catch {
        // The socket is on its way out: keep the signal for its replacement.
      }
    }
    const queue = this.liveQueue(to);
    if (queue.length < MAX_PENDING_SIGNALS) {
      queue.push({ from, raw, expiresAt: this.host.now() + this.pendingSignalTtlMs });
      this.queued.set(to, queue);
    }
  }

  private flush(id: string, sock: RoomSocket): void {
    for (const q of this.liveQueue(id)) sock.send(q.raw);
    this.queued.delete(id);
  }

  private liveQueue(id: string): QueuedSignal[] {
    const now = this.host.now();
    const live = (this.queued.get(id) ?? []).filter((q) => q.expiresAt > now);
    if (live.length > 0) this.queued.set(id, live);
    else this.queued.delete(id);
    return live;
  }

  private dropSignalsFrom(from: string): void {
    for (const [to, queue] of this.queued) {
      const kept = queue.filter((q) => q.from !== from);
      if (kept.length > 0) this.queued.set(to, kept);
      else this.queued.delete(to);
    }
  }

  private replace(sock: RoomSocket): void {
    sock.setAttachment({ role: "gone" });
    sock.close(CLOSE_NORMAL, "replaced");
  }

  private signalSockets(): SignalSocket[] {
    return this.host.sockets().filter((s): s is SignalSocket => s.attachment.role === "signal");
  }

  private readyAgent(): RoomSocket | undefined {
    return this.host
      .sockets()
      .find((s) => s.attachment.role === "agent" && "ready" in s.attachment);
  }

  private schedule(): void {
    let next: number | null = null;
    for (const { attachment: a } of this.host.sockets()) {
      const at =
        a.role === "agent" && "deadline" in a ? a.deadline : a.role === "signal" ? a.exp : undefined;
      if (at !== undefined && (next === null || at < next)) next = at;
    }
    this.host.setAlarm(next);
  }
}
