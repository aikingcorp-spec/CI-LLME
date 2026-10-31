import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import type { Attachment, RoomHost, RoomSocket } from "./room.js";
import { Room } from "./room.js";
import { admissionOf } from "./room-link.js";
import { touchLastSeen } from "./store.js";

/** One node's signaling room, over hibernatable WebSockets: ping/pong never wakes the object. */
export class NodeRoom extends DurableObject<Env> {
  private readonly room: Room;
  private readonly wrapped = new WeakMap<WebSocket, RoomSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    const host: RoomHost = {
      sockets: () => ctx.getWebSockets().map((ws) => this.wrap(ws)),
      now: () => Date.now(),
      setAlarm: (at) => {
        void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at));
      },
      agentSeen: (nodeId, at) => {
        ctx.waitUntil(touchLastSeen(env.DB, nodeId, at));
      },
    };
    this.room = new Room(host);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const admission = admissionOf(request.headers);
    if (admission === undefined) return new Response("bad request", { status: 400 });
    const attachment = this.room.admit(admission);
    if ("status" in attachment) return new Response("conflict", { status: attachment.status });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [attachment.role]);
    server.serializeAttachment(attachment);
    this.room.open(this.wrap(server));
    // The Worker leaves only the neutral subprotocol on the request; echo it so browsers accept the socket.
    const subprotocol = request.headers.get("sec-websocket-protocol");
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: subprotocol ? { "sec-websocket-protocol": subprotocol } : {},
    });
  }

  online(): boolean {
    return this.room.online();
  }

  kick(): void {
    this.room.kick();
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.room.message(this.wrap(ws), message);
  }

  override webSocketClose(ws: WebSocket): void {
    this.room.close(this.wrap(ws));
  }

  override webSocketError(ws: WebSocket): void {
    this.room.close(this.wrap(ws));
  }

  override alarm(): void {
    this.room.sweep();
  }

  private wrap(ws: WebSocket): RoomSocket {
    let sock = this.wrapped.get(ws);
    if (sock === undefined) {
      sock = {
        get attachment() {
          return ws.deserializeAttachment() as Attachment;
        },
        setAttachment: (a) => ws.serializeAttachment(a),
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      };
      this.wrapped.set(ws, sock);
    }
    return sock;
  }
}
