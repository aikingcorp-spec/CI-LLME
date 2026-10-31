import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { captureWhenReady } from "./screenshot-hook.js";

function target(readyAfter: number, destroyed = false) {
  let calls = 0;
  return {
    calls: () => calls,
    isDestroyed: () => destroyed,
    executeJavaScript: async () => ++calls > readyAfter,
    capturePage: async () => ({ toPNG: () => Buffer.from("png-bytes") }),
  };
}

describe("captureWhenReady", () => {
  it("polls until the sign-in form is present, then writes the PNG", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-shot-"));
    try {
      const file = path.join(dir, "shot.png");
      const t = target(2);
      expect(await captureWhenReady({ target: t, file, sleep: async () => {} })).toBe(true);
      expect(t.calls()).toBe(3);
      expect((await readFile(file)).toString()).toBe("png-bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives up at the deadline without writing", async () => {
    let clock = 0;
    const t = target(Number.POSITIVE_INFINITY);
    const done = await captureWhenReady({
      target: t,
      file: "/nonexistent/never-written.png",
      timeoutMs: 1000,
      intervalMs: 400,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(done).toBe(false);
  });

  it("stops when the window is gone", async () => {
    expect(
      await captureWhenReady({ target: target(0, true), file: "/x.png", sleep: async () => {} }),
    ).toBe(false);
  });
});
