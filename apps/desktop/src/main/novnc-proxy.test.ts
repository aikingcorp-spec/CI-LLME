import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCREEN_TARGET_ENDPOINT, sealScreenCapability } from "@rakazo/core/node/screen-capability";
import { SCREEN_PROBE_PARAM } from "@rakazo/core/screen-reconnect";
import { expect, it } from "vitest";
import { allocateLoopbackPort } from "./local-stack.js";
import { nativeWeb } from "./native-web.js";

it("proxies /novnc/* HTTP, probe, and WebSocket traffic via SCREEN_TARGET_ENDPOINT", async () => {
  const secret = "s".repeat(64);
  const root = await mkdtemp(path.join(tmpdir(), "native-web-novnc-"));
  const webPort = await allocateLoopbackPort();
  const apiPort = await allocateLoopbackPort();
  const vncPort = await allocateLoopbackPort();

  const vncSockets = new Set<net.Socket>();
  const vncServer = createServer((req, res) => {
    if (req.url === "/vnc_lite.html") {
      res.setHeader("content-type", "text/html");
      res.setHeader("set-cookie", "leak=nope");
      res.end("<html><head><title>noVNC</title></head><body><div id='screen'></div></body></html>");
      return;
    }
    res.writeHead(404).end();
  });
  vncServer.on("connection", (socket) => {
    vncSockets.add(socket);
    socket.once("close", () => vncSockets.delete(socket));
  });
  vncServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "Set-Cookie: leaked=1",
        "\r\n",
      ].join("\r\n"),
    );
    socket.on("data", (chunk) => socket.write(chunk));
  });

  const apiServer = createServer((req, res) => {
    if (req.method === "POST" && req.url === SCREEN_TARGET_ENDPOINT) {
      expect(req.headers.authorization).toBe(`Bearer ${secret}`);
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { path: string };
        const isAllowed = body.path.startsWith("/novnc/session/");
        if (!isAllowed) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            protocol: "http:",
            hostname: "127.0.0.1",
            port: vncPort,
            path: "/vnc_lite.html",
            interactive: true,
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });

  const server = nativeWeb({
    port: webPort,
    apiPort,
    web: root,
    screenProxySecret: secret,
  });

  try {
    await writeFile(path.join(root, "index.html"), "<!doctype html><html>VNBot</html>");
    await new Promise<void>((resolve) => vncServer.listen(vncPort, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
    await server.start(new AbortController().signal);

    const sealed = sealScreenCapability(
      `http://127.0.0.1:${vncPort}/vnc_lite.html?view_only=false`,
      secret,
      `http://127.0.0.1:${webPort}`,
      {
        botId: "bot-1",
        computerId: "comp-1",
        botGeneration: 1,
        computerGeneration: 1,
        controlLeaseId: "lease-1",
      },
    );
    const sealedUrl = new URL(sealed);
    const capabilityPath = `${sealedUrl.pathname}${sealedUrl.search}`;

    // Denied unsealed path
    const refused = await fetch(`http://127.0.0.1:${webPort}/novnc/other`);
    expect(refused.status).toBe(403);

    // Status-only probe returns 204 when reachable
    const probe = await fetch(
      `http://127.0.0.1:${webPort}${capabilityPath}&${SCREEN_PROBE_PARAM}=1`,
    );
    expect(probe.status).toBe(204);

    // Double-slash prefix (noVNC quirk) works and injects sandbox CSP & shim while stripping Set-Cookie
    const html = await fetch(`http://127.0.0.1:${webPort}/${capabilityPath}`);
    expect(html.status).toBe(200);
    expect(html.headers.get("set-cookie")).toBeNull();
    expect(html.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await html.text()).toContain("rakazoScreen");

    // WebSocket upgrade passes through and strips sensitive handshake headers
    const handshake = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(webPort, "127.0.0.1", () => {
        sock.write(
          [
            `GET /${capabilityPath} HTTP/1.1`,
            `Host: 127.0.0.1:${webPort}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "\r\n",
          ].join("\r\n"),
        );
      });
      sock.once("data", (buf) => {
        sock.destroy();
        resolve(buf.toString("latin1"));
      });
      sock.once("error", reject);
    });
    expect(handshake).toContain("HTTP/1.1 101 Switching Protocols");
    expect(handshake).not.toContain("Set-Cookie");
  } finally {
    await server.stop();
    for (const sock of vncSockets) sock.destroy();
    apiServer.closeAllConnections();
    vncServer.closeAllConnections();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await new Promise<void>((resolve) => vncServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
