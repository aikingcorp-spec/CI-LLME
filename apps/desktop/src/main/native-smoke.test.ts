import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SmokeStack } from "./native-smoke.js";
import { acceptSmokeOutput, ensureSmokeUserData, runNativeSmoke } from "./native-smoke.js";

const web = "http://127.0.0.1:43123";

function stack(overrides: Partial<SmokeStack> = {}): SmokeStack {
  return {
    start: vi.fn(async () => ({ phase: "ready", message: null })),
    stop: vi.fn(async () => undefined),
    webUrl: vi.fn(() => web),
    matchesDesiredStack: vi.fn(async () => true),
    ...overrides,
  };
}

describe("native smoke", () => {
  it("keeps a caller-supplied profile and otherwise allocates a smoke directory", () => {
    const supplied: NodeJS.ProcessEnv = {
      RAKAZO_DESKTOP_SMOKE: "1",
      RAKAZO_PERFORMANCE_USER_DATA: "/tmp/vnbot-desktop-smoke",
    };
    const createTemp = vi.fn(() => "/tmp/vnbot-desktop-smoke-generated");
    ensureSmokeUserData(supplied, createTemp);
    expect(supplied.RAKAZO_PERFORMANCE_USER_DATA).toBe("/tmp/vnbot-desktop-smoke");
    expect(createTemp).not.toHaveBeenCalled();

    const generated: NodeJS.ProcessEnv = { RAKAZO_DESKTOP_SMOKE: "1" };
    ensureSmokeUserData(generated, createTemp);
    expect(generated.RAKAZO_PERFORMANCE_USER_DATA).toBe("/tmp/vnbot-desktop-smoke-generated");

    const normal: NodeJS.ProcessEnv = {};
    ensureSmokeUserData(normal, createTemp);
    expect(normal.RAKAZO_PERFORMANCE_USER_DATA).toBeUndefined();
  });

  it("reports loopback readiness only after the native stack is healthy and stopped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-smoke-"));
    const running = stack();
    const print = vi.fn();
    try {
      expect(await runNativeSmoke({ stack: running, userDataDir: dir, print })).toBe(0);
      expect(running.start).toHaveBeenCalledOnce();
      expect(running.matchesDesiredStack).toHaveBeenCalledOnce();
      expect(running.stop).toHaveBeenCalledOnce();
      const stdout = print.mock.calls.map((call) => call[0]).join("\n");
      expect(acceptSmokeOutput(stdout, 0)).toEqual({ ok: true, web });
      expect(stdout).not.toContain("app.vnbot.run");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["identity", "Native identity setup is required."],
    ["postgres", "Native bundle must provide PostgreSQL 18."],
    ["startup", "postgres://secret@db"],
  ] as const)("names %s and still stops the stack", async (check, message) => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-smoke-"));
    const running = stack({
      start: vi.fn(async () => ({ phase: "failed", message })),
    });
    const print = vi.fn();
    try {
      expect(await runNativeSmoke({ stack: running, userDataDir: dir, print })).toBe(1);
      expect(print).toHaveBeenCalledWith(`RAKAZO_DESKTOP_SMOKE fail ${check}`);
      expect(print.mock.calls.flat().join("\n")).not.toContain("secret");
      expect(running.stop).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a production web address and a stack that never became ready", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vnbot-desktop-smoke-"));
    const production = stack({ webUrl: vi.fn(() => "https://app.vnbot.run") });
    const unhealthy = stack({ matchesDesiredStack: vi.fn(async () => false) });
    const print = vi.fn();
    try {
      expect(await runNativeSmoke({ stack: production, userDataDir: dir, print })).toBe(1);
      expect(print).toHaveBeenCalledWith("RAKAZO_DESKTOP_SMOKE fail web");
      expect(await runNativeSmoke({ stack: unhealthy, userDataDir: dir, print })).toBe(1);
      expect(print).toHaveBeenCalledWith("RAKAZO_DESKTOP_SMOKE fail health");
      expect(acceptSmokeOutput("RAKAZO_DESKTOP_SMOKE ok https://app.vnbot.run", 0).ok).toBe(false);
      expect(acceptSmokeOutput(`RAKAZO_DESKTOP_SMOKE ok ${web}`, 0).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
