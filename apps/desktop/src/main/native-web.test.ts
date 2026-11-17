import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as rawRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { allocateLoopbackPort } from "./local-stack.js";
import { nativeWeb } from "./native-web.js";

it("allows only the pinned portal to frame native HTML without restricting existing network providers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-web-portal-"));
  const webPort = await allocateLoopbackPort();
  const server = nativeWeb({
    port: webPort,
    apiPort: 1,
    web: root,
    portalOrigin: "https://portal.example.test",
  });
  try {
    await writeFile(path.join(root, "index.html"), "<!doctype html><html>VNBot</html>");
    await writeFile(path.join(root, "html-viewer.html"), "<!doctype html><html>Viewer</html>");
    await server.start(new AbortController().signal);
    const main = await fetch(`http://127.0.0.1:${webPort}/app`);
    expect(main.headers.get("content-security-policy")).toBe(
      "frame-ancestors https://portal.example.test",
    );
    const viewer = await fetch(`http://127.0.0.1:${webPort}/html-viewer.html`);
    expect(viewer.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'self' https://portal.example.test",
    );
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function rawGet(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = rawRequest({ hostname: "127.0.0.1", port, path: urlPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

it("serves the local web root and refuses to read outside it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-web-"));
  const web = path.join(root, "web");
  const apiPort = await allocateLoopbackPort();
  const webPort = await allocateLoopbackPort();
  const token = "a".repeat(64);
  const api = createServer((request, response) => {
    response.end(request.url === "/health" ? "api-ok" : "no");
  });
  const server = nativeWeb({ port: webPort, apiPort, web, token });
  try {
    await mkdir(web);
    await writeFile(path.join(web, "index.html"), "<p>local</p>");
    const assets = [
      {
        name: "site.webmanifest",
        contentType: "application/manifest+json",
        body: Buffer.from('{"name":"VNBot"}'),
      },
      {
        name: "favicon.ico",
        contentType: "image/x-icon",
        body: Buffer.from([0, 0, 1, 0, 1, 0]),
      },
    ];
    for (const asset of assets) await writeFile(path.join(web, asset.name), asset.body);
    await writeFile(path.join(root, "secret.txt"), "secret");
    await new Promise<void>((resolve) => api.listen(apiPort, "127.0.0.1", resolve));
    await server.start(new AbortController().signal);
    const page = await fetch(`http://127.0.0.1:${webPort}/`);
    expect(await page.text()).toBe("<p>local</p>");
    for (const asset of assets) {
      const response = await fetch(`http://127.0.0.1:${webPort}/${asset.name}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(asset.contentType);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(asset.body);
    }
    for (const urlPath of ["/../secret.txt", "/%2e%2e/secret.txt"]) {
      const escaped = await rawGet(webPort, urlPath);
      expect(escaped.status).toBe(403);
      expect(escaped.body).not.toContain("secret");
    }
    const denied = await fetch(`http://127.0.0.1:${webPort}/.well-known/rakazo-desktop-stack`);
    expect(denied.status).toBe(401);
    const admitted = await fetch(`http://127.0.0.1:${webPort}/.well-known/rakazo-desktop-stack`, {
      headers: { "x-rakazo-desktop-stack-token": token },
    });
    expect(await admitted.json()).toEqual({ imageTag: "native" });
    expect(await (await fetch(`http://127.0.0.1:${webPort}/health`)).text()).toBe("api-ok");
  } finally {
    await server.stop();
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
