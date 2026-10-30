import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNativeServices } from "./native-services.js";
import { readPrivateFile } from "./setup-store.js";

describe("native services", () => {
  it("starts utility processes with desktop sandbox and serves the web", async () => {
    const forks: Array<{ entry: string; env: NodeJS.ProcessEnv; cwd?: string }> = [];
    const children = () => ({ once: vi.fn().mockReturnThis(), kill: vi.fn() });
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-test-"));
    const services = createNativeServices({
      userDataDir: root,
      appPath: "/repo/apps/desktop",
      elevated: () => false,
      allocatePort: vi
        .fn()
        .mockResolvedValueOnce(43101)
        .mockResolvedValueOnce(43102)
        .mockResolvedValueOnce(43103),
      fork: (entry, _args, options) => {
        forks.push({ entry, env: options.env, cwd: options.cwd });
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
      expect(forks[0]!.env.RAKAZO_HOST_COMMANDS_ELEVATED).toBeUndefined();
      // The job runner reads ./crontab; it must not depend on the launch directory.
      expect(forks.map((f) => f.cwd)).toEqual([root, root]);
      expect(await readPrivateFile(path.join(root, "crontab"), 1024)).toMatch(/^#/);
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

describe("native web port", () => {
  async function freshRoot() {
    return mkdtemp(path.join(tmpdir(), "rakazo-web-port-"));
  }

  it("keeps its file next to the API port file, with Windows paths", async () => {
    const { nativeWebPortFilePath } = await import("./native-services.js");
    expect(nativeWebPortFilePath("C:\\Profiles\\test\\Roaming\\VNBot", path.win32)).toBe(
      "C:\\Profiles\\test\\Roaming\\VNBot\\native-web-port",
    );
  });

  it("allocates and saves a port on the first launch", async () => {
    const { chooseNativeWebPort, nativeWebPortFilePath } = await import("./native-services.js");
    const root = await freshRoot();
    try {
      const port = await chooseNativeWebPort({
        userDataDir: root,
        reserved: [],
        allocatePort: async () => 43555,
        isFree: async () => true,
      });
      expect(port).toBe(43555);
      expect(await readPrivateFile(nativeWebPortFilePath(root), 32)).toBe("43555");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the saved port on the next launch without allocating", async () => {
    const { chooseNativeWebPort } = await import("./native-services.js");
    const root = await freshRoot();
    try {
      const options = { userDataDir: root, reserved: [], isFree: async () => true };
      await chooseNativeWebPort({ ...options, allocatePort: async () => 43556 });
      const allocatePort = vi.fn(async () => 49999);
      expect(await chooseNativeWebPort({ ...options, allocatePort })).toBe(43556);
      expect(allocatePort).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to a new port when the saved one is busy, and saves that one", async () => {
    const { chooseNativeWebPort, nativeWebPortFilePath } = await import("./native-services.js");
    const root = await freshRoot();
    try {
      await chooseNativeWebPort({
        userDataDir: root,
        reserved: [],
        allocatePort: async () => 43557,
        isFree: async () => true,
      });
      const next = await chooseNativeWebPort({
        userDataDir: root,
        reserved: [],
        allocatePort: async () => 43558,
        isFree: async (port) => port !== 43557,
      });
      expect(next).toBe(43558);
      expect(await readPrivateFile(nativeWebPortFilePath(root), 32)).toBe("43558");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reuse a saved port that the API or worker now holds", async () => {
    const { chooseNativeWebPort } = await import("./native-services.js");
    const root = await freshRoot();
    try {
      await chooseNativeWebPort({
        userDataDir: root,
        reserved: [],
        allocatePort: async () => 43559,
        isFree: async () => true,
      });
      expect(
        await chooseNativeWebPort({
          userDataDir: root,
          reserved: [43559],
          allocatePort: async () => 43560,
          isFree: async () => true,
        }),
      ).toBe(43560);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a corrupt or out-of-range saved port", async () => {
    const { chooseNativeWebPort, nativeWebPortFilePath } = await import("./native-services.js");
    const { writePrivateFile } = await import("./setup-store.js");
    const root = await freshRoot();
    try {
      for (const bad of ["not a port", "80", "70000", ""]) {
        await writePrivateFile(nativeWebPortFilePath(root), bad);
        expect(
          await chooseNativeWebPort({
            userDataDir: root,
            reserved: [],
            allocatePort: async () => 43561,
            isFree: async () => true,
          }),
        ).toBe(43561);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("actually detects a busy loopback port by default", async () => {
    const { chooseNativeWebPort, nativeWebPortFilePath } = await import("./native-services.js");
    const { writePrivateFile } = await import("./setup-store.js");
    const { createServer } = await import("node:http");
    const root = await freshRoot();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const busy = (holder.address() as { port: number }).port;
    try {
      await writePrivateFile(nativeWebPortFilePath(root), String(busy));
      const port = await chooseNativeWebPort({
        userDataDir: root,
        reserved: [],
        allocatePort: async () => 43562,
      });
      expect(port).toBe(43562);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves the same web origin across two launches", async () => {
    const root = await freshRoot();
    const make = (apiPort: number) =>
      createNativeServices({
        userDataDir: root,
        appPath: "/repo/apps/desktop",
        serveWeb: false,
        allocatePort: vi
          .fn()
          .mockResolvedValueOnce(apiPort)
          .mockResolvedValueOnce(apiPort + 1)
          .mockResolvedValue(43570),
        isPortFree: async () => true,
        fork: () => ({ once: vi.fn().mockReturnThis(), kill: vi.fn() }),
        fetch: vi.fn().mockResolvedValue({ ok: true }),
      });
    try {
      const first = make(43580);
      const a = await first.start();
      await first.stop();
      const second = make(43590);
      const b = await second.start();
      await second.stop();
      expect(a.webUrl).toBe("http://127.0.0.1:43570");
      expect(b.webUrl).toBe(a.webUrl);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("tells the backend when the app runs as an administrator", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-services-elevated-"));
  const envs: NodeJS.ProcessEnv[] = [];
  const services = createNativeServices({
    userDataDir: root,
    serveWeb: false,
    elevated: () => true,
    allocatePort: async () => 43130,
    fork: (_entry, _args, options) => {
      envs.push(options.env);
      return { once: vi.fn().mockReturnThis(), kill: vi.fn() };
    },
    fetch: vi.fn().mockResolvedValue({ ok: true }),
  });
  try {
    await services.start();
    expect(envs.map((env) => env.RAKAZO_HOST_COMMANDS_ELEVATED)).toEqual(["1", "1"]);
  } finally {
    await services.stop();
    await rm(root, { recursive: true, force: true });
  }
});
