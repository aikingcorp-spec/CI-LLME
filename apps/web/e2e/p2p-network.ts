import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import type { Route } from "@playwright/test";

export function isLocalUrl(raw: string): boolean {
  const url = new URL(raw);
  return (
    ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}

/** Route.fetch bypasses browser routing, so validate before fetching and never follow redirects. */
export async function fetchLoopback(route: Route, target = route.request().url()) {
  if (!isLocalUrl(route.request().url()) || !isLocalUrl(target)) {
    await route.abort();
    return undefined;
  }
  const response = await route.fetch({ url: target, maxRedirects: 0 });
  const location = response.headers().location;
  if (
    response.status() >= 300 &&
    response.status() < 400 &&
    location &&
    !isLocalUrl(new URL(location, target).href)
  ) {
    await route.abort();
    return undefined;
  }
  return response;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("No local port");
  return address.port;
}

/** The suite's dev server has no gateway; P2P needs a separate server built with an explicit URL. */
export async function startConfiguredWeb(webRoot: string, gatewayUrl: string) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn(path.join(webRoot, "node_modules/.bin/vite"), {
    cwd: webRoot,
    env: {
      ...process.env,
      WEB_PORT: String(port),
      VITE_P2P_GATEWAY_URL: gatewayUrl,
      VITE_DEFAULT_UI_LOCALE: "en",
    },
    stdio: "ignore",
  });
  const close = () => {
    server.kill();
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (
      await fetch(url).then(
        (res) => res.ok,
        () => false,
      )
    )
      return { url, close };
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  close();
  throw new Error("Configured web server did not start");
}
