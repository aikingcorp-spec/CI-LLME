import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunProcess } from "./native-postgres.js";

class FakeChild extends EventEmitter {
  stdout: PassThrough | null = new PassThrough();
  stderr: PassThrough | null = new PassThrough();
  stdin: Writable | null = new Writable({ write: (_chunk, _enc, done) => done() });
  killed: string | undefined;
  kill(signal: string) {
    this.killed = signal;
    return true;
  }
}

function setup(configure?: (child: FakeChild) => void) {
  const child = new FakeChild();
  configure?.(child);
  const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
  return { child, spawnProcess, run: createRunProcess(spawnProcess) };
}

describe("runProcess", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves on close with the captured output", async () => {
    const { child, run } = setup();
    const lines: string[] = [];
    const pending = run("tool", [], { env: {}, timeoutMs: 1000, onLine: (l) => lines.push(l) });
    child.stdout?.write("hello\nwor");
    child.stderr?.write("warn\n");
    child.emit("exit", 0);
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({
      code: 0,
      stdout: "hello\nwor",
      stderr: "warn\n",
      timedOut: false,
    });
    expect(lines).toEqual(["hello", "warn", "wor"]);
  });

  it("resolves after exit when close never fires", async () => {
    const { child, run } = setup();
    const pending = run("pg_ctl", [], { env: {}, timeoutMs: 60_000 });
    child.stdout?.write("server started\n");
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result).toEqual({ code: 0, stdout: "server started\n", stderr: "", timedOut: false });
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
  });

  it("settles with timedOut when a killed child never reports exit", async () => {
    const { child, run } = setup();
    const pending = run("pg_ctl", [], { env: {}, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.killed).toBe("SIGKILL");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ code: null, timedOut: true });
  });

  it("settles when aborted and the child never reports exit", async () => {
    const { run } = setup();
    const controller = new AbortController();
    const pending = run("tool", [], { env: {}, timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toMatchObject({ code: null, timedOut: false });
  });

  it("rejects when the process cannot start", async () => {
    const { child, run } = setup();
    const pending = run("missing", [], { env: {}, timeoutMs: 1000 });
    child.emit("error", new Error("spawn missing ENOENT"));
    await expect(pending).rejects.toThrow("ENOENT");
  });

  it("hands the child no pipes when output is discarded", async () => {
    const { child, spawnProcess, run } = setup((c) => {
      c.stdout = null;
      c.stderr = null;
      c.stdin = null;
    });
    const pending = run("pg_ctl", ["start"], { env: {}, timeoutMs: 1000, discardOutput: true });
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ code: 0 });
    expect(vi.mocked(spawnProcess).mock.calls[0]?.[2]).toMatchObject({
      stdio: ["ignore", "ignore", "ignore"],
    });
  });

  it("pipes all three streams by default", async () => {
    const { child, spawnProcess, run } = setup();
    const pending = run("tool", [], { env: {}, timeoutMs: 1000 });
    child.emit("close", 0);
    await pending;
    expect(vi.mocked(spawnProcess).mock.calls[0]?.[2]).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
    });
  });
});
