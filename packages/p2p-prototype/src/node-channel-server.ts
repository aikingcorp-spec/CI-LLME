import { setTimeout } from "node:timers/promises";
import type { ChannelFrame } from "./channel-protocol.js";
import { decodeBytes, decodeChannelFrame, encodeBytes } from "./channel-protocol.js";
import type { ClientResponse } from "./client-transport.js";
import type { LocalHandler } from "./node-agent.js";
import type { NodeAuth, NodeSession } from "./node-auth.js";
import type { DataPeer } from "./webrtc-peer.js";

export interface NodeChannelHandler {
  call(
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ): Promise<ClientResponse>;
  subscribe(
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

/** Wire this callback into createNodeAuth's onRevoke. */
export function createNodeChannelServer(auth: NodeAuth, handler: NodeChannelHandler) {
  const channels = new Map<string, () => void>();
  return {
    onRevoke(session: NodeSession): void {
      channels.get(session.bearer)?.();
    },
    async accept(peer: DataPeer): Promise<void> {
      let session: NodeSession | undefined;
      const active = new Map<string, AbortController>();
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        for (const controller of active.values()) controller.abort();
        closing ??= peer.closeGracefully();
        return closing;
      };
      const send = (frame: ChannelFrame): void => peer.send(JSON.stringify(frame));
      const dispatch = async (
        frame: Extract<ChannelFrame, { t: "call" | "subscribe" }>,
        bearer: string,
        controller: AbortController,
      ): Promise<void> => {
        try {
          const body = decodeBytes(frame.body);
          if (frame.t === "call") {
            const result = await handler.call(frame.procedure, frame.headers, body);
            if (!controller.signal.aborted)
              send({
                t: "response",
                bearer,
                id: frame.id,
                ...result,
                body: encodeBytes(result.body),
              });
          } else {
            for await (const chunk of handler.subscribe(
              frame.procedure,
              frame.headers,
              body,
              controller.signal,
            )) {
              if (controller.signal.aborted) return;
              send({ t: "chunk", bearer, id: frame.id, data: encodeBytes(chunk) });
            }
            if (!controller.signal.aborted) send({ t: "end", bearer, id: frame.id });
          }
        } catch {
          if (!controller.signal.aborted)
            send({ t: "error", bearer, id: frame.id, message: "handler failed" });
        } finally {
          active.delete(frame.id);
        }
      };
      try {
        await peer.open;
        for await (const raw of peer.messages) {
          if (closing) break;
          const frame = decodeChannelFrame(raw);
          if (!session) {
            session = frame.t === "hello" ? auth.acceptAssertion(frame.assertion) : undefined;
            if (!session) {
              send({ t: "denied" });
              break;
            }
            channels.set(session.bearer, () => {
              void close().catch(() => {});
            });
            send({ t: "welcome", bearer: session.bearer });
            continue;
          }
          if (
            !("bearer" in frame) ||
            frame.bearer !== session.bearer ||
            !auth.checkBearer(frame.bearer)
          )
            break;
          if (frame.t === "cancel") active.get(frame.id)?.abort();
          else if (frame.t === "call" || frame.t === "subscribe") {
            if (active.has(frame.id)) break;
            const controller = new AbortController();
            active.set(frame.id, controller);
            void dispatch(frame, session.bearer, controller);
          } else break;
        }
      } catch {
        // Malformed frames terminate the channel without exposing auth details.
      } finally {
        await close();
        if (session) {
          channels.delete(session.bearer);
          auth.revokeBearer(session.bearer);
        }
      }
    },
  };
}

export function demoHandler(): NodeChannelHandler {
  return {
    async call(procedure, headers, body) {
      return {
        status: procedure === "echo" ? 200 : 404,
        headers: { "content-type": headers["content-type"] ?? "application/octet-stream" },
        body: procedure === "echo" ? body : new Uint8Array(),
      };
    },
    async *subscribe(procedure, _headers, body, signal) {
      if (procedure !== "ticks") throw new Error("unknown subscription");
      const options = JSON.parse(new TextDecoder().decode(body)) as {
        count: number;
        intervalMs: number;
      };
      if (
        !Number.isInteger(options.count) ||
        options.count < 0 ||
        options.count > 1000 ||
        !Number.isInteger(options.intervalMs) ||
        options.intervalMs < 0 ||
        options.intervalMs > 1000
      )
        throw new Error("invalid ticks options");
      for (let i = 0; i < options.count; i++) {
        await setTimeout(options.intervalMs, undefined, { signal });
        yield new TextEncoder().encode(`data: tick ${i}\n\n`);
      }
    },
  };
}

/** v0 HTTP relay buffers the stream into one response. */
export function channelHttpHandler(handler: NodeChannelHandler): LocalHandler {
  return async (req) => {
    const procedure = decodeURIComponent(
      new URL(req.path, "http://node").pathname.replace(/^\/(?:rpc\/)?/, ""),
    );
    if (req.headers.accept !== "text/event-stream")
      return handler.call(procedure, req.headers, req.body);
    const chunks: Uint8Array[] = [];
    for await (const chunk of handler.subscribe(
      procedure,
      req.headers,
      req.body,
      req.signal ?? new AbortController().signal,
    ))
      chunks.push(chunk);
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: Buffer.concat(chunks),
    };
  };
}

/** Shares a local HTTP API across the relay and data-channel seams. */
export function forwardChannelHandler(
  target: string,
  localHeaders: Record<string, string> = {},
): NodeChannelHandler {
  const request = (
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
    signal?: AbortSignal,
  ) => {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)*$/.test(procedure))
      throw new Error("Invalid RPC procedure");
    return fetch(
      new URL(`/rpc/${procedure.split("/").map(encodeURIComponent).join("/")}`, target),
      {
        method: "POST",
        headers: (() => {
          const safe = new Headers();
          for (const [key, value] of Object.entries(headers)) {
            if (
              [
                "content-type",
                "accept",
                "x-rakazo-space-id",
                "x-vnbot-ui-locale",
                "x-rakazo-client-build",
                "x-rakazo-identity-confirmation",
              ].includes(key.toLowerCase())
            )
              safe.set(key, value);
          }
          // A remote caller never chooses the local account or supplies host credentials.
          for (const key of [
            "authorization",
            "cookie",
            "host",
            "origin",
            "x-rakazo-local-settings-token",
          ])
            safe.delete(key);
          for (const [key, value] of Object.entries(localHeaders)) safe.set(key, value);
          return safe;
        })(),
        redirect: "error",
        body: new Uint8Array(body),
        signal,
      },
    );
  };
  return {
    async call(procedure, headers, body) {
      const res = await request(procedure, headers, body);
      return {
        status: res.status,
        headers: Object.fromEntries(
          [...res.headers].filter(
            ([name]) =>
              ![
                "set-cookie",
                "authorization",
                "www-authenticate",
                "connection",
                "transfer-encoding",
                "content-length",
                "content-encoding",
              ].includes(name),
          ),
        ),
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
    async *subscribe(procedure, headers, body, signal) {
      const res = await request(
        procedure,
        { ...headers, accept: "text/event-stream" },
        body,
        signal,
      );
      if (!res.ok || !res.body) throw new Error(`subscribe failed: ${res.status}`);
      const reader = res.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    },
  };
}
