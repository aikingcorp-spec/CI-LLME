import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer, request } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { NativeRuntimeService } from "./native-runtime.js";

/** Loopback static host for the built web app, with API and websocket routes proxied locally. */
export function nativeWeb(input: {
  port: number;
  apiPort: number;
  web: string;
  token?: string;
}): NativeRuntimeService {
  let webServer: Server | undefined;
  const sockets = new Set<Duplex>();
  return {
    async start(signal) {
      signal.throwIfAborted();
      const server = createServer(async (req, res) => {
        const pathname = (req.url ?? "/").split("?")[0] ?? "/";
        if (pathname === "/.well-known/rakazo-desktop-stack") {
          const supplied = req.headers["x-rakazo-desktop-stack-token"];
          const token = input.token;
          const valid =
            token !== undefined &&
            typeof supplied === "string" &&
            supplied.length === token.length &&
            /^[a-f0-9]{64}$/.test(supplied) &&
            timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
          res.setHeader("cache-control", "no-store");
          res.setHeader("content-type", "application/json");
          res.writeHead(valid ? 200 : 401).end(JSON.stringify(valid ? { imageTag: "native" } : {}));
          return;
        }
        if (
          pathname === "/health" ||
          pathname === "/rpc" ||
          pathname.startsWith("/rpc/") ||
          pathname === "/api" ||
          pathname.startsWith("/api/") ||
          pathname.startsWith("/.well-known/") ||
          pathname.startsWith("/novnc/")
        ) {
          const upstream = request(
            {
              hostname: "127.0.0.1",
              port: input.apiPort,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            (response) => {
              res.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(res);
            },
          );
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          });
          res.on("close", () => upstream.destroy());
          req.pipe(upstream);
          return;
        }
        try {
          const requested = decodeURIComponent(pathname);
          const file = path.resolve(input.web, `.${requested}`);
          const relative = path.relative(input.web, file);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            res.writeHead(403).end();
            return;
          }
          const extension = path.extname(file);
          const target = extension ? file : path.join(input.web, "index.html");
          const body = await readFile(target);
          const types: Record<string, string> = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".webmanifest": "application/manifest+json",
            ".ico": "image/x-icon",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".woff2": "font/woff2",
          };
          res.setHeader("content-type", types[path.extname(target)] ?? "application/octet-stream");
          res.end(body);
        } catch {
          if (!res.headersSent) res.writeHead(404);
          res.end();
        }
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (req, socket, head) => {
        if (!req.url?.startsWith("/api/") && !req.url?.startsWith("/novnc/")) {
          socket.destroy();
          return;
        }
        const upstream = request({
          hostname: "127.0.0.1",
          port: input.apiPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        });
        upstream.once("upgrade", (response, peer, peerHead) => {
          socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
          }
          socket.write("\r\n");
          if (peerHead.length) socket.write(peerHead);
          if (head.length) peer.write(head);
          socket.pipe(peer).pipe(socket);
          socket.once("close", () => peer.destroy());
          peer.once("error", () => socket.destroy());
          peer.once("close", () => socket.destroy());
        });
        upstream.once("response", (response) => {
          response.resume();
          socket.destroy();
        });
        upstream.once("error", () => socket.destroy());
        socket.once("error", () => upstream.destroy());
        socket.once("close", () => upstream.destroy());
        upstream.end();
      });
      webServer = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject).listen(input.port, "127.0.0.1", resolve);
      });
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const server = webServer;
      if (server?.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      webServer = undefined;
    },
  };
}
