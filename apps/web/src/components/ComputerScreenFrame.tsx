import { P2P_SCREEN_PATH } from "@rakazo/contracts/content-security-policy";
import { screenSocketPath } from "@rakazo/p2p-prototype/browser";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useRef } from "react";
import { activeP2PClient } from "../lib/p2p-client";

/** Local embeds keep their existing proxy. Hosted embeds use a bundled viewer over the node channel. */
export function ComputerScreenFrame({ src, ref, onLoad, ...props }: ComponentProps<"iframe">) {
  const client = activeP2PClient();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const stopped = useRef<(() => void) | undefined>(undefined);
  const assign = useCallback(
    (value: HTMLIFrameElement | null) => {
      frame.current = value;
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    },
    [ref],
  );
  useEffect(
    () => () => {
      stopped.current?.();
    },
    [src, client],
  );
  return (
    <iframe
      {...props}
      ref={assign}
      src={client ? P2P_SCREEN_PATH : src}
      sandbox={client ? "allow-scripts allow-same-origin allow-pointer-lock" : props.sandbox}
      onLoad={(event) => {
        onLoad?.(event);
        stopped.current?.();
        if (!client || !src || !frame.current?.contentWindow) return;
        const target = frame.current.contentWindow;
        const onReady = (message: MessageEvent) => {
          if (
            message.source !== target ||
            message.origin !== location.origin ||
            message.data?.rakazoScreenReady !== true
          )
            return;
          window.removeEventListener("message", onReady);
          const controller = new AbortController();
          const channel = new MessageChannel();
          const port = channel.port1;
          let socket: Awaited<ReturnType<typeof client.openScreen>> | undefined;
          let acknowledge: (() => void) | undefined;
          let ackTimer: ReturnType<typeof setTimeout> | undefined;
          let writing = false;
          let closed = false;
          const stop = () => {
            if (closed) return;
            closed = true;
            controller.abort();
            clearTimeout(ackTimer);
            acknowledge?.();
            socket?.close();
            port.postMessage({ t: "close" });
            port.close();
          };
          stopped.current = stop;
          const url = new URL(src, location.href);
          let path: string;
          try {
            path = screenSocketPath(src);
          } catch {
            stop();
            return;
          }
          target.postMessage(
            { p2pScreen: true, viewOnly: !url.pathname.startsWith("/novnc/session/control/") },
            location.origin,
            [channel.port2],
          );
          port.onmessage = ({ data }) => {
            if (closed) return;
            if (data?.t === "ack" && acknowledge) {
              const ack = acknowledge;
              acknowledge = undefined;
              ack();
            } else if (
              data?.t === "data" &&
              socket &&
              !writing &&
              data.data instanceof ArrayBuffer &&
              data.data.byteLength <= 16384
            ) {
              writing = true;
              void socket
                .write(new Uint8Array(data.data))
                .then(() => {
                  writing = false;
                  if (!closed) port.postMessage({ t: "ack" });
                })
                .catch(stop);
            } else if (data?.t === "close") stop();
            else stop();
          };
          void (async () => {
            try {
              socket = await client.openScreen(path, controller.signal);
              if (closed) {
                socket.close();
                return;
              }
              port.postMessage({ t: "open" });
              for await (const bytes of socket.read) {
                if (closed) break;
                const data = new Uint8Array(bytes).buffer;
                await new Promise<void>((resolve) => {
                  acknowledge = resolve;
                  ackTimer = setTimeout(stop, 10000);
                  port.postMessage({ t: "data", data }, [data]);
                });
                clearTimeout(ackTimer);
              }
            } catch {
              if (!closed) port.postMessage({ t: "error" });
            } finally {
              stop();
            }
          })();
        };
        stopped.current = () => window.removeEventListener("message", onReady);
        window.addEventListener("message", onReady);
        target.postMessage({ p2pScreenReadyRequest: true }, location.origin);
      }}
    />
  );
}
