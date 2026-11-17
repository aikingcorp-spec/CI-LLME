import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRemoteDeviceKey } from "@rakazo/auth";
import { expect, it } from "vitest";
import { allocateLoopbackPort } from "../../desktop/src/main/local-stack.js";
import { nativeWeb } from "../../desktop/src/main/native-web.js";
import { createRemoteRegistryClient } from "./remote-registry-client.js";

it("registers the web host so a connector can reach both the UI and API", async () => {
  const web = await mkdtemp(path.join(tmpdir(), "remote-web-origin-"));
  const apiPort = await allocateLoopbackPort();
  const webPort = await allocateLoopbackPort();
  const api = createServer((request, response) => {
    response.writeHead(request.url === "/api/ok" ? 200 : 404);
    response.end(request.url === "/api/ok" ? "api-ok" : "no-ui-here");
  });
  const server = nativeWeb({ port: webPort, apiPort, web });
  try {
    await writeFile(path.join(web, "index.html"), "<!doctype html><html>VNBot</html>");
    await new Promise<void>((resolve) => api.listen(apiPort, "127.0.0.1", resolve));
    await server.start(new AbortController().signal);
    // NativeStack assigns WEB_ORIGIN to this host, separately from API_PORT.
    const webOrigin = `http://127.0.0.1:${webPort}`;
    expect((await fetch(`http://127.0.0.1:${apiPort}/`)).status).toBe(404);
    const keys = createRemoteDeviceKey();
    const registry = createRemoteRegistryClient({
      origin: "https://identity.example.test",
      deviceId: "device-1",
      privateKey: keys.privateKey,
      originService: webOrigin,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.originService).toBe(webOrigin);
        const root = await fetch(body.originService);
        expect(root.status).toBe(200);
        expect(await root.text()).toContain("<html>VNBot</html>");
        expect(await (await fetch(new URL("/api/ok", body.originService))).text()).toBe("api-ok");
        return Response.json({ portal: { kind: "unavailable", devices: [] } });
      },
    });
    await registry.present();
  } finally {
    await server.stop();
    await new Promise<void>((resolve, reject) =>
      api.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(web, { recursive: true, force: true });
  }
});
