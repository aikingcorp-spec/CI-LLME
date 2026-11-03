import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppAdapter } from "electron-updater/out/AppAdapter.js";
import type { ElectronHttpExecutor as HttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import type { NsisUpdater as WindowsUpdater } from "electron-updater/out/NsisUpdater.js";
import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateController } from "./auto-update.js";

vi.mock("./monitoring.js", () => ({ reportDesktopError: vi.fn() }));

const require = createRequire(import.meta.url);
const {
  NsisUpdater,
}: { NsisUpdater: typeof WindowsUpdater } = require("electron-updater/out/NsisUpdater.js");
const {
  ElectronHttpExecutor,
}: {
  ElectronHttpExecutor: typeof HttpExecutor;
} = require("electron-updater/out/electronHttpExecutor.js");

describe("public Windows update feed", () => {
  it.each([false, true])("checks and verifies the download, corrupt=%s", async (corrupt) => {
    const directory = await mkdtemp(path.join(tmpdir(), "desktop-feed-"));
    // This is intentionally not an executable. The test never invokes installation.
    const installer = Buffer.from("offline installer fixture, never executed");
    const sha512 = createHash("sha512").update(installer).digest("base64");
    const requests: string[] = [];
    const server = createServer((incoming, response) => {
      expect(incoming.headers.authorization).toBeUndefined();
      const pathname = new URL(incoming.url!, "http://localhost").pathname;
      requests.push(pathname);
      if (pathname === "/latest.yml") {
        response.end(
          `version: 0.3.8\nfiles:\n  - url: VNBot-Setup-0.3.8-x64.exe\n` +
            `    sha512: ${sha512}\n    size: ${installer.length}\n` +
            `path: VNBot-Setup-0.3.8-x64.exe\nsha512: ${sha512}\n`,
        );
      } else if (pathname === "/VNBot-Setup-0.3.8-x64.exe") {
        response.end(corrupt ? Buffer.from("corrupt installer") : installer);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No fixture address");
      const config = path.join(directory, "app-update.yml");
      await writeFile(
        config,
        `provider: generic\nurl: http://127.0.0.1:${address.port}/\nupdaterCacheDirName: cache\n`,
      );
      const app: AppAdapter = {
        version: "0.3.7",
        name: "VNBot",
        isPackaged: true,
        appUpdateConfigPath: config,
        userDataPath: directory,
        baseCachePath: directory,
        whenReady: async () => {},
        quit: () => {
          throw new Error("Must not quit in a feed test");
        },
        relaunch: () => {
          throw new Error("Must not relaunch in a feed test");
        },
        onQuit: () => {},
      };
      const updater = new NsisUpdater(null, app);
      const executor = new ElectronHttpExecutor();
      // Exercise the real SDK parser, cache and digest validation over HTTP. Only
      // Electron's native networking is replaced, so this also runs in Node CI.
      Object.defineProperty(executor, "createRequest", { value: request });
      updater.httpExecutor = executor;
      Object.defineProperty(updater, "_testOnlyOptions", { value: { platform: "win32" } });
      updater.disableDifferentialDownload = true;
      updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
      const controller = new DesktopUpdateController(
        { packaged: true, version: "0.3.7", disabled: true },
        async () => updater,
      );
      await controller.check(false);
      expect(requests).toEqual([]);
      await controller.check(true);
      await vi.waitFor(() => expect(controller.state().phase).toBe(corrupt ? "error" : "ready"));
      expect(requests).toEqual(["/latest.yml", "/VNBot-Setup-0.3.8-x64.exe"]);
      if (corrupt) {
        expect(controller.state().percent).not.toBe(100);
        expect(await readdir(path.join(directory, "cache", "pending"))).toEqual([]);
      } else {
        expect(controller.state().availableVersion).toBe("0.3.8");
        const pending = path.join(directory, "cache", "pending");
        const file = (await readdir(pending)).find((name) => name.endsWith(".exe"));
        expect(file).toBeDefined();
        expect(await readFile(path.join(pending, file!))).toEqual(installer);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});
