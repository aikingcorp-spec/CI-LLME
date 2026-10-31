import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readStackWebUrl } from "./local-stack.js";
import {
  nativeWebUrlFile,
  postgresLogTail,
  redactLogLine,
  runNativeSmoke,
  smokeStageReporter,
} from "./native-smoke.js";

/** The local node's HTTP surface as the smoke sees it, with one switch per check. */
function fakeNode(
  options: { health?: number; capabilities?: Response; page?: Response; session?: Response } = {},
): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/auth/get-session") {
      const cookie = new Headers(init?.headers).get("cookie");
      return Response.json(cookie ? { user: { email: "smoke@example.com" } } : null);
    }
    if (pathname === "/api/desktop-settings/session")
      return (
        options.session ??
        new Response("{}", { headers: { "set-cookie": "better-auth.session_token=a; Path=/" } })
      );
    if (pathname === "/health") return new Response("ok", { status: options.health ?? 200 });
    if (pathname === "/api/auth/capabilities")
      return options.capabilities ?? Response.json({ emailCode: false, passwordAuth: true });
    if (pathname === "/sign-in")
      return (
        options.page ??
        new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } })
      );
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("native smoke", () => {
  it.each([
    ["capabilities", { capabilities: new Response("", { status: 500 }) }],
    ["capabilities", { capabilities: Response.json({ passwordAuth: true }) }],
    ["sign-in-page", { page: new Response("", { status: 404 }) }],
    ["sign-in-page", { page: Response.json({}) }],
    ["startup", { session: new Response("", { status: 401 }) }],
  ])("fails at %s when the sign-in surface is not usable", async (check, options) => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-smoke-"));
    try {
      const print = vi.fn();
      const code = await runNativeSmoke({
        stack: { start: async () => ({ webUrl: "http://127.0.0.1:43123" }), stop: async () => {} },
        userDataDir: dir,
        fetch: fakeNode(options),
        print,
        printError: vi.fn(),
        readPostgresLog: async () => "",
        readStackToken: async () => "ab".repeat(32),
      });
      expect(code).toBe(1);
      expect(print).toHaveBeenCalledExactlyOnceWith(`RAKAZO_DESKTOP_SMOKE fail ${check}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
      const fetchImpl = fakeNode({ health: typeof outcome === "number" ? outcome : 200 });
      try {
        expect(
          await runNativeSmoke({
            stack,
            userDataDir: dir,
            fetch: fetchImpl,
            print,
            readStackToken: async () => "ab".repeat(32),
          }),
        ).toBe(outcome === 200 ? 0 : 1);
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

  it("reports stages only in smoke mode", () => {
    const write = vi.fn();
    expect(smokeStageReporter({}, write)).toBeUndefined();
    smokeStageReporter({ RAKAZO_DESKTOP_SMOKE: "1" }, write)?.("postgres-start");
    expect(write).toHaveBeenCalledExactlyOnceWith("RAKAZO_DESKTOP_SMOKE stage=postgres-start");
  });

  it("marks the health stage once the stack is up", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-smoke-"));
    const onStage = vi.fn();
    try {
      await runNativeSmoke({
        stack: { start: async () => ({ webUrl: "http://127.0.0.1:43123" }), stop: async () => {} },
        userDataDir: dir,
        fetch: fakeNode(),
        print: vi.fn(),
        onStage,
        readStackToken: async () => "ab".repeat(32),
      });
      expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(["health", "sign-in"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("masks credentials in the server log", () => {
    const secret = "ab".repeat(24);
    expect(redactLogLine(`STATEMENT:  CREATE ROLE x LOGIN PASSWORD '${secret}' NOSUPERUSER`)).toBe(
      "STATEMENT:  CREATE ROLE x LOGIN PASSWORD '***' NOSUPERUSER",
    );
    expect(redactLogLine(`url postgres://rakazo:${secret}@127.0.0.1:5/db failed`)).toBe(
      "url postgres://*** failed",
    );
    expect(redactLogLine(`token ${secret}`)).toBe("token ***");
  });

  it("keeps the last 40 non-empty log lines", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}\n\n`).join("");
    const tail = postgresLogTail(text);
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe("line 20");
    expect(tail.at(-1)).toBe("line 59");
  });

  it("prints the redacted log tail to stderr on failure, and nothing on success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-smoke-"));
    const log = `FATAL: boom\nSTATEMENT: CREATE ROLE a PASSWORD '${"ab".repeat(24)}'\n`;
    try {
      for (const ok of [false, true]) {
        const printError = vi.fn();
        const code = await runNativeSmoke({
          stack: {
            start: async () => {
              if (!ok) throw new Error("x");
              return { webUrl: "http://127.0.0.1:43123" };
            },
            stop: async () => {},
          },
          userDataDir: dir,
          fetch: fakeNode(),
          print: vi.fn(),
          printError,
          readPostgresLog: async () => log,
          readStackToken: async () => "ab".repeat(32),
        });
        expect(code).toBe(ok ? 0 : 1);
        if (ok) expect(printError).not.toHaveBeenCalled();
        else
          expect(printError.mock.calls.map(([line]) => line)).toEqual([
            "RAKAZO_DESKTOP_SMOKE postgres-log-tail",
            "FATAL: boom",
            "STATEMENT: CREATE ROLE a PASSWORD '***'",
          ]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("excludes postgres log lines from before this smoke run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-smoke-"));
    const file = path.join(dir, "pg", "postgres.log");
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "STALE FAILURE\n");
      const printError = vi.fn();
      await runNativeSmoke({
        stack: {
          start: async () => {
            await appendFile(file, "CURRENT FAILURE\n");
            throw new Error("startup");
          },
          stop: async () => {},
        },
        userDataDir: dir,
        print: vi.fn(),
        printError,
      });
      expect(printError.mock.calls.map(([line]) => line)).toEqual([
        "RAKAZO_DESKTOP_SMOKE postgres-log-tail",
        "CURRENT FAILURE",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
