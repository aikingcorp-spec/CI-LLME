import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNativeServices } from "./native-services.js";
import { readPrivateFile } from "./setup-store.js";

describe("native services", () => {
  it("starts utility processes with desktop sandbox and serves the web", async () => {
    const forks: Array<{ entry: string; env: NodeJS.ProcessEnv }> = [];
    const children = () => ({ once: vi.fn().mockReturnThis(), kill: vi.fn() });
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-test-"));
    const services = createNativeServices({
      userDataDir: root,
      appPath: "/repo/apps/desktop",
      allocatePort: vi
        .fn()
        .mockResolvedValueOnce(43101)
        .mockResolvedValueOnce(43102)
        .mockResolvedValueOnce(43103),
      fork: (entry, _args, options) => {
        forks.push({ entry, env: options.env });
        return children();
      },
      fetch: vi.fn().mockResolvedValue({ ok: true }),
      webDir: "/tmp/does-not-exist",
      serveWeb: false,
    });
    try {
      const result = await services.start();
      expect(result.webUrl).toBe("http://127.0.0.1:43103");
      expect(forks).toHaveLength(2);
      expect(forks[0]!.env.SANDBOX_PROVIDER).toBe("desktop");
      expect(forks[0]!.entry).toBe(
        path.resolve("/repo/apps/desktop", "..", "..", "apps", "api", "dist", "index.js"),
      );
      expect(await readPrivateFile(`${root}/native-stack-env`, 65536)).toContain(
        "BETTER_AUTH_SECRET",
      );
    } finally {
      await services.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("resolves Windows service entries and API port files using injected paths", async () => {
  const { nativePortFilePath, resolveNativeEntryPath } = await import("./native-services.js");
  expect(
    resolveNativeEntryPath(
      { packaged: true, resourcesPath: "C:\\App\\resources", pathModule: path.win32 },
      "api",
    ),
  ).toBe("C:\\App\\resources\\server\\api\\dist\\index.js");
  expect(nativePortFilePath("C:\\Profiles\\test\\Roaming\\VNBot", path.win32)).toBe(
    "C:\\Profiles\\test\\Roaming\\VNBot\\native-api-port",
  );
});

it("serves SPA assets and proxies API requests on one loopback origin", async () => {
  const { createServer } = await import("node:http");
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-web-proxy-"));
  const api = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("healthy");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("No API port");
  let allocations = 0;
  const { allocateLoopbackPort } = await import("./local-stack.js");
  const children: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
  const services = createNativeServices({
    userDataDir: root,
    appPath: "/repo/apps/desktop",
    webDir: root,
    allocatePort: async () => (++allocations === 1 ? address.port : allocateLoopbackPort()),
    fork: () => {
      const child = { once: vi.fn().mockReturnThis(), kill: vi.fn() };
      children.push(child);
      return child;
    },
  });
  try {
    await writeFile(path.join(root, "index.html"), "<html>app</html>");
    await writeFile(path.join(root, "app.js"), "export {};");
    const { webUrl } = await services.start({
      DATABASE_URL: "postgres://runtime:fake@127.0.0.1:5432/rakazo",
    });
    expect(await (await fetch(`${webUrl}/health`)).text()).toBe("healthy");
    expect(await (await fetch(`${webUrl}/thread/123`)).text()).toBe("<html>app</html>");
    expect((await fetch(`${webUrl}/app.js`)).headers.get("content-type")).toBe("text/javascript");
    const response = await fetch(`${webUrl}/rpc/test?q=1`, { method: "POST", body: "input" });
    expect(await response.json()).toEqual({ method: "POST", url: "/rpc/test?q=1", body: "input" });
    expect(children).toHaveLength(2);
  } finally {
    await services.stop();
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
    await new Promise<void>((resolve) => api.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("kills the API if forking the worker fails without exposing child details", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-services-fail-"));
  const kill = vi.fn();
  let forks = 0;
  const services = createNativeServices({
    userDataDir: root,
    serveWeb: false,
    allocatePort: async () => 43123,
    fork: () => {
      if (++forks === 2) throw new Error("private path and credentials");
      return { once: vi.fn().mockReturnThis(), kill };
    },
  });
  try {
    await expect(services.start()).rejects.toThrow("Native services could not start.");
    expect(kill).toHaveBeenCalledOnce();
  } finally {
    await services.stop();
    await rm(root, { recursive: true, force: true });
  }
});
