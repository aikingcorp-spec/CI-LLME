import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readStackWebUrl } from "./local-stack.js";
import { nativeWebUrlFile, runNativeSmoke } from "./native-smoke.js";

describe("native smoke", () => {
  it("finds the Windows port file under APPDATA with injected platform and paths", () => {
    expect(
      nativeWebUrlFile({
        platform: "win32",
        pathModule: path.win32,
        env: { APPDATA: "C:\\Profiles\\test\\Roaming" },
        homedir: "C:\\Profiles\\test",
      }),
    ).toBe("C:\\Profiles\\test\\Roaming\\VNBot\\stack\\.desktop-web-url");
    expect(
      nativeWebUrlFile({
        platform: "linux",
        pathModule: path.posix,
        env: { XDG_CONFIG_HOME: "/config" },
        homedir: "/home/test",
      }),
    ).toBe("/config/VNBot/stack/.desktop-web-url");
  });

  it.each([200, 503, "startup", "shutdown"])(
    "checks health and exits with sanitized output for %s",
    async (outcome) => {
      const dir = await mkdtemp(path.join(tmpdir(), "rakazo-smoke-"));
      const stack = {
        start: vi.fn(async () => {
          if (outcome === "startup") throw new Error("postgres://private:secret@host/db");
          return { webUrl: "http://127.0.0.1:43123" };
        }),
        stop: vi.fn(async () => {
          if (outcome === "shutdown") throw new Error("private");
        }),
      };
      const print = vi.fn();
      const fetchImpl = vi.fn(async () => ({
        status: typeof outcome === "number" ? outcome : 200,
      })) as unknown as typeof fetch;
      try {
        expect(await runNativeSmoke({ stack, userDataDir: dir, fetch: fetchImpl, print })).toBe(
          outcome === 200 ? 0 : 1,
        );
        expect(stack.stop).toHaveBeenCalledOnce();
        expect(print).toHaveBeenCalledExactlyOnceWith(
          outcome === 200
            ? "RAKAZO_DESKTOP_SMOKE ok http://127.0.0.1:43123"
            : `RAKAZO_DESKTOP_SMOKE fail ${outcome === 503 ? "health" : outcome}`,
        );
        if (outcome !== "startup") {
          const file = path.join(dir, "stack", ".desktop-web-url");
          expect(await readFile(file, "utf8")).toBe("http://127.0.0.1:43123");
          expect(await readStackWebUrl(path.join(dir, "stack"), "fallback")).toBe(
            "http://127.0.0.1:43123",
          );
          if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
