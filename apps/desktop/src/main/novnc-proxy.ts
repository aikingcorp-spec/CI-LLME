import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import https from "node:https";
import net, { connect } from "node:net";
import type { Duplex, Readable } from "node:stream";
import tls from "node:tls";
import type { ScreenProxyTarget } from "@rakazo/core/node/screen-capability";
import {
  isScreenProxyTarget,
  SCREEN_RECHECK_MS,
  SCREEN_TARGET_ENDPOINT,
  SCREEN_UNCONFIRMED_MAX_MS,
} from "@rakazo/core/node/screen-capability";
import {
  safeScreenProxyResponseHeaders,
  stripSensitiveHandshakeHeaders,
} from "@rakazo/core/node/screen-proxy-response";
import { SCREEN_PROBE_PARAM } from "@rakazo/core/screen-reconnect";

const MAX_NOVNC_HTML_BYTES = 1024 * 1024;
const SCREEN_UPSTREAM_TIMEOUT_MS = 20_000;
const NOVNC_PAGES = new Set(["vnc.html", "vnc_lite.html", "embed.html"]);
const NOVNC_EXTENSION_ERROR = /^[a-z-]+-extension:/;

const FORWARDED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "origin",
  "pragma",
  "range",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "transfer-encoding",
  "upgrade",
  "user-agent",
]);

export type ScreenTargetFailure =
  | "invalid_path"
  | "authority_rejected"
  | "invalid_authority_response"
  | "authority_unavailable";

export type ScreenCheck = "allowed" | "denied" | "unavailable";
export type ScreenRevokeReason = "denied" | "unconfirmed_window" | "expired";

/**
 * Stock noVNC builds its socket URL as host + "/" + path, so the absolute capability path arrives
 * as "//novnc/...". Collapse leading slashes so that socket reaches the proxy instead of hanging.
 */
export function novncRequestPath(url: string | undefined): string | null {
  const normalized = url?.replace(/^\/{2,}/, "/");
  return normalized?.startsWith("/novnc/") ? normalized : null;
}

export async function resolveNovncTarget(
  url: string | undefined,
  secret: string,
  api: string,
  onFailure?: (reason: ScreenTargetFailure) => void,
): Promise<ScreenProxyTarget | null> {
  if (!url?.startsWith("/novnc/session/")) {
    onFailure?.("invalid_path");
    return null;
  }
  try {
    const response = await fetch(new URL(SCREEN_TARGET_ENDPOINT, api), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ path: url }),
    });
    if (!response.ok) {
      onFailure?.(
        response.status >= 500 || response.status === 408 || response.status === 429
          ? "authority_unavailable"
          : "authority_rejected",
      );
      return null;
    }
    let target: unknown;
    try {
      target = await response.json();
    } catch (error) {
      onFailure?.(
        error instanceof SyntaxError ? "invalid_authority_response" : "authority_unavailable",
      );
      return null;
    }
    if (isScreenProxyTarget(target)) return target;
    onFailure?.("invalid_authority_response");
    return null;
  } catch {
    onFailure?.("authority_unavailable");
    return null;
  }
}

export function screenProbePath(url: string | undefined): string | null {
  const queryAt = url?.indexOf("?") ?? -1;
  if (!url || queryAt < 0) return null;
  const mark = `${SCREEN_PROBE_PARAM}=1`;
  const pairs = url.slice(queryAt + 1).split("&");
  if (!pairs.includes(mark)) return null;
  const rest = pairs.filter((pair) => pair !== mark);
  return rest.length ? `${url.slice(0, queryAt)}?${rest.join("&")}` : url.slice(0, queryAt);
}

export function screenUpstreamReachable(target: ScreenProxyTarget, timeoutMs = 1_000) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: target.hostname, port: target.port });
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function screenProbeStatus(
  target: ScreenProxyTarget | null,
  reason: ScreenTargetFailure | undefined,
  reachable = true,
) {
  if (!target) return screenRefusal(reason).status;
  return reachable ? 204 : 502;
}

export function screenRefusal(reason: ScreenTargetFailure | undefined) {
  return reason === "authority_unavailable"
    ? { status: 503, body: "Screen unavailable" }
    : { status: 403, body: "Invalid or expired screen capability" };
}

function screenTargetOrigin(target: Pick<ScreenProxyTarget, "protocol" | "hostname" | "port">) {
  const defaultPort = target.protocol === "https:" ? 443 : 80;
  return `${target.protocol}//${target.hostname}${target.port === defaultPort ? "" : `:${target.port}`}`;
}

export function safeProxyHeaders(
  headers: IncomingHttpHeaders,
  target?: Pick<ScreenProxyTarget, "protocol" | "hostname" | "port" | "headers">,
) {
  const forwarded: IncomingHttpHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      return value != null && FORWARDED_HEADERS.has(key.toLowerCase());
    }),
  );
  if (target && forwarded.origin) forwarded.origin = screenTargetOrigin(target);
  return { ...forwarded, ...target?.headers };
}

function sameScreenTarget(a: ScreenProxyTarget, b: ScreenProxyTarget) {
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.path === b.path &&
    a.interactive === b.interactive
  );
}

export async function checkScreenAuthorization(
  url: string | undefined,
  secret: string,
  api: string,
  opened: ScreenProxyTarget,
): Promise<ScreenCheck> {
  let failure: ScreenTargetFailure | undefined;
  const target = await resolveNovncTarget(url, secret, api, (reason) => {
    failure = reason;
  });
  if (target) return sameScreenTarget(target, opened) ? "allowed" : "denied";
  return failure === "authority_unavailable" ? "unavailable" : "denied";
}

export function screenCapabilityExpiry(url: string | undefined): number | undefined {
  const expiresAt = Number(url?.match(/^\/novnc\/session\/(?:view|control)\/(\d+)\./)?.[1]);
  return Number.isSafeInteger(expiresAt) ? expiresAt : undefined;
}

export function watchScreenAuthorization(
  check: () => Promise<ScreenCheck>,
  revoke: (reason: ScreenRevokeReason) => void,
  options: {
    confirmedAt?: number;
    expiresAt?: number;
  } = {},
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let unconfirmed: ReturnType<typeof setTimeout>;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(unconfirmed);
    clearTimeout(expiry);
  };
  const end = (reason: ScreenRevokeReason) => {
    if (stopped) return;
    stop();
    revoke(reason);
  };
  const confirm = (sentAt: number) => {
    clearTimeout(unconfirmed);
    unconfirmed = setTimeout(
      () => end("unconfirmed_window"),
      Math.max(0, sentAt + SCREEN_UNCONFIRMED_MAX_MS - performance.now()),
    );
    unconfirmed.unref?.();
  };
  const tick = async () => {
    const sentAt = performance.now();
    let result: ScreenCheck = "denied";
    try {
      result = await check();
    } catch {
      /* Fail closed. */
    }
    if (stopped) return;
    if (result === "denied") return end("denied");
    if (result === "allowed") confirm(sentAt);
    timer = setTimeout(tick, SCREEN_RECHECK_MS);
    timer.unref?.();
  };
  confirm(options.confirmedAt ?? performance.now());
  if (options.expiresAt !== undefined) {
    const left = Math.min(Math.max(0, options.expiresAt - Date.now()), 2 ** 31 - 1);
    expiry = setTimeout(() => end("expired"), left);
    expiry.unref?.();
  }
  timer = setTimeout(tick, SCREEN_RECHECK_MS);
  timer.unref?.();
  return stop;
}

function isNovncPage(targetPath: string) {
  const { pathname } = new URL(targetPath, "http://upstream.invalid");
  return NOVNC_PAGES.has(pathname.slice(pathname.lastIndexOf("/") + 1));
}

function shouldInjectNovncStorageShim(headers: IncomingHttpHeaders, targetPath: string) {
  if (!isNovncPage(targetPath)) return false;
  const encoding = String(headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") return false;
  const contentType = String(headers["content-type"] ?? "").toLowerCase();
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

function novncPageRequestHeaders<T extends Record<string, unknown>>(headers: T) {
  const {
    "if-modified-since": _since,
    "if-none-match": _match,
    ...rest
  } = headers as Record<string, unknown>;
  return { ...rest, "accept-encoding": "identity" };
}

function rewrittenNovncHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const {
    "content-length": _length,
    etag: _etag,
    "last-modified": _modified,
    expires: _expires,
    ...rest
  } = headers;
  return { ...rest, "cache-control": "no-store, no-transform" };
}

export function injectNovncStorageShim(html: string, { viewOnly = false } = {}) {
  const chrome = `<style>#noVNC_status{display:none!important}${
    viewOnly ? "#noVNC_control_bar_anchor{display:none!important}" : ""
  }</style>`;
  const shim = `${chrome}<script>
(() => {
  const memoryStorage = () => {
    const items = new Map();
    return {
      getItem(key) { return items.has(String(key)) ? items.get(String(key)) : null; },
      setItem(key, value) { items.set(String(key), String(value)); },
      removeItem(key) { items.delete(String(key)); },
      clear() { items.clear(); },
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
  }
  window.addEventListener("error", (event) => {
    if (/${NOVNC_EXTENSION_ERROR.source}/.test(String(event.filename))) event.stopImmediatePropagation();
  }, true);
  try { delete window.VideoDecoder; } catch {}
  const report = (rakazoScreen, detail) => {
    try {
      window.parent.postMessage(detail ? { rakazoScreen, detail } : { rakazoScreen }, "*");
    } catch {}
    try {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ rakazoScreen }));
    } catch {}
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== window.parent ||
      !data ||
      typeof data !== "object" ||
      Object.keys(data).length !== 1 ||
      data.rakazoScreenFocus !== true
    )
      return;
    const canvas = document.querySelector("#screen canvas, #noVNC_container canvas, canvas");
    try {
      canvas?.focus();
    } catch {}
  });
  let last = "";
  let classed = false;
  const sync = () => {
    const root = document.documentElement;
    const status = document.getElementById("noVNC_status");
    const failure = root.getAttribute("data-rakazo-screen-error");
    const statusError =
      status && status.classList.contains("noVNC_open") && status.classList.contains("noVNC_status_error");
    const connecting =
      root.classList.contains("noVNC_connecting") || root.classList.contains("noVNC_reconnecting");
    const connected = root.classList.contains("noVNC_connected");
    if (connecting || connected) classed = true;
    const state = connected
      ? "connected"
      : failure !== null || statusError
        ? "failed"
        : connecting
          ? "connecting"
          : classed
            ? last === "connected" || last === "connecting"
              ? "disconnected"
              : ""
            : document.querySelector("#screen canvas")
              ? "connecting"
              : "";
    if (!state || state === last) return;
    last = state;
    report(state, state === "failed" ? failure || String(status?.textContent || "") : undefined);
  };
  const observe = () => {
    sync();
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-rakazo-screen-error"],
      childList: true,
      subtree: true,
    });
  };
  report("loading");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
  else observe();
})();
</script>`;
  return html.includes("<head>")
    ? html.replace("<head>", `<head>${shim}`)
    : html.replace(/<script\b/i, `${shim}<script`);
}

function collectNovncHtml(incoming: Readable, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      incoming.destroy();
      reject(error);
    };
    incoming.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new Error(`noVNC document exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    });
    incoming.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    incoming.on("error", (error: unknown) => {
      fail(error instanceof Error ? error : new Error("noVNC upstream failed"));
    });
    incoming.on("aborted", () => {
      fail(new Error("noVNC upstream aborted"));
    });
    incoming.on("close", () => {
      if (!settled) fail(new Error("noVNC upstream closed"));
    });
  });
}

/** Proxies `/novnc/*` HTTP and WebSocket streams using API's signed capability resolver. */
export function createNovncProxy({ apiOrigin, secret }: { apiOrigin: string; secret: string }) {
  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const requestPath = novncRequestPath(req.url);
    if (!requestPath) return false;

    const confirmedAt = performance.now();
    const probe = screenProbePath(requestPath);
    let refusal: ScreenTargetFailure | undefined;
    const target = await resolveNovncTarget(probe ?? requestPath, secret, apiOrigin, (reason) => {
      refusal = reason;
    });
    if (res.destroyed) return true;
    if (probe) {
      const reachable = target ? await screenUpstreamReachable(target) : false;
      if (res.destroyed) return true;
      res.statusCode = screenProbeStatus(target, refusal, reachable);
      res.setHeader("cache-control", "no-store");
      res.end();
      return true;
    }
    if (!target) {
      const { status, body } = screenRefusal(refusal);
      res.statusCode = status;
      res.end(body);
      return true;
    }

    const forwarded = safeProxyHeaders(req.headers, target);
    const headers = {
      ...(isNovncPage(target.path) ? novncPageRequestHeaders(forwarded) : forwarded),
      host: `${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
    };
    const transport = target.protocol === "https:" ? https : http;
    let upstream: ClientRequest | undefined;
    let retries = 0;
    let retryPending = false;
    let stopChecking: () => void = () => undefined;
    const retryable = req.method === "GET";
    const scheduleRetry = (incoming?: IncomingMessage) => {
      if (!retryable || retryPending || retries >= 3 || res.destroyed) return false;
      retryPending = true;
      retries += 1;
      const delayMs = 50 * retries;
      const retry = () => {
        setTimeout(() => {
          retryPending = false;
          if (!res.destroyed) requestUpstream();
        }, delayMs);
      };
      if (incoming && !incoming.destroyed) {
        incoming.once("close", retry);
        incoming.destroy();
      } else {
        retry();
      }
      return true;
    };
    let downstreamFinished = false;
    const finishUnavailable = (reason: string) => {
      if (downstreamFinished || res.destroyed || res.writableEnded) return;
      downstreamFinished = true;
      stopChecking();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 502;
      res.end(`Screen unavailable (${reason})`);
    };

    const requestUpstream = () => {
      if (res.destroyed) return;
      upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: req.method,
          headers,
          ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
        },
        (incoming) => {
          if ((incoming.statusCode ?? 502) >= 500 && scheduleRetry(incoming)) {
            return;
          }
          const responseHeaders = safeScreenProxyResponseHeaders(incoming.headers);
          if (shouldInjectNovncStorageShim(responseHeaders, target.path)) {
            const declaredLength = Number(incoming.headers["content-length"] ?? 0);
            if (Number.isFinite(declaredLength) && declaredLength > MAX_NOVNC_HTML_BYTES) {
              finishUnavailable("html_too_large");
              incoming.destroy();
              return;
            }
            void collectNovncHtml(incoming, MAX_NOVNC_HTML_BYTES)
              .then((html) => {
                if (downstreamFinished || res.destroyed || res.writableEnded) return;
                downstreamFinished = true;
                const body = injectNovncStorageShim(html, { viewOnly: !target.interactive });
                res.writeHead(incoming.statusCode ?? 502, rewrittenNovncHeaders(responseHeaders));
                res.end(body);
              })
              .catch(() => {
                finishUnavailable("html_read_failed");
              });
            return;
          }
          res.writeHead(incoming.statusCode ?? 502, responseHeaders);
          incoming.pipe(res);
        },
      );
      const current = upstream;
      const headersTimer = setTimeout(() => {
        finishUnavailable("upstream_timeout");
        current.destroy();
      }, SCREEN_UPSTREAM_TIMEOUT_MS);
      current.once("response", () => clearTimeout(headersTimer));
      current.once("close", () => clearTimeout(headersTimer));
      upstream.on("error", () => {
        if (
          retryable &&
          !downstreamFinished &&
          !res.headersSent &&
          !res.destroyed &&
          (retryPending || scheduleRetry())
        ) {
          return;
        }
        finishUnavailable("upstream_error");
      });
      if (req.method === "GET" || req.readableEnded) upstream.end();
      else req.pipe(upstream);
    };

    stopChecking = watchScreenAuthorization(
      () => checkScreenAuthorization(requestPath, secret, apiOrigin, target),
      () => {
        upstream?.destroy();
        res.destroy();
      },
      { confirmedAt, expiresAt: screenCapabilityExpiry(requestPath) },
    );
    res.once("close", () => {
      stopChecking();
      upstream?.destroy();
    });
    requestUpstream();
    return true;
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const requestPath = novncRequestPath(req.url);
    if (!requestPath) return false;
    if (socket.destroyed || socket.writableEnded) return true;

    socket.on("error", () => {});
    const confirmedAt = performance.now();
    const target = await resolveNovncTarget(requestPath, secret, apiOrigin);
    if (socket.destroyed) return true;
    if (!target) {
      socket.destroy();
      return true;
    }

    const upstream =
      target.protocol === "https:"
        ? tls.connect({ port: target.port, host: target.hostname, servername: target.hostname })
        : net.connect(target.port, target.hostname);
    const stopChecking = watchScreenAuthorization(
      () => checkScreenAuthorization(requestPath, secret, apiOrigin, target),
      () => {
        socket.destroy();
        upstream.destroy();
      },
      { confirmedAt, expiresAt: screenCapabilityExpiry(requestPath) },
    );
    socket.once("close", () => {
      stopChecking();
      upstream.destroy();
    });
    upstream.once("close", () => {
      stopChecking();
      socket.destroy();
    });
    upstream.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
      const headerLines = [
        `${req.method ?? "GET"} ${target.path} HTTP/1.1`,
        `Host: ${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port}`,
      ];
      for (const [key, value] of Object.entries(safeProxyHeaders(req.headers, target))) {
        headerLines.push(`${key}: ${Array.isArray(value) ? value.join(",") : value}`);
      }
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      const responseChunks: Buffer[] = [];
      let responseSize = 0;
      let responseTail = Buffer.alloc(0);
      const forwardHandshake = (chunk: Buffer) => {
        responseChunks.push(chunk);
        responseSize += chunk.length;
        if (responseSize > 64 * 1024) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        const boundarySearch = Buffer.concat([responseTail, chunk]);
        if (boundarySearch.indexOf("\r\n\r\n") < 0) {
          responseTail = Buffer.from(boundarySearch.subarray(-3));
          return;
        }
        const responseHead = Buffer.concat(responseChunks, responseSize);
        const safe = stripSensitiveHandshakeHeaders(responseHead);
        if (!safe) {
          socket.destroy();
          upstream.destroy();
          return;
        }
        upstream.off("data", forwardHandshake);
        socket.write(safe);
        upstream.pipe(socket);
      };
      upstream.on("data", forwardHandshake);
    });
    upstream.on("error", () => {
      socket.destroy();
    });
    return true;
  }

  return { handleHttp, handleUpgrade };
}
