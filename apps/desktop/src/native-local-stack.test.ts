import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readStackWebUrl } from "./local-stack.js";
import { NativeLocalStackController } from "./native-local-stack.js";

describe("native local stack setup contract", () => {
  it("publishes the native address and state without Docker setup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-controller-"));
    let running = false;
    const stack = {
      start: vi.fn(async () => {
        running = true;
        return { databaseUrl: "fake", migrationUrl: "fake", webUrl: "http://127.0.0.1:43123" };
      }),
      stop: vi.fn(async () => {
        running = false;
      }),
      status: () => (running ? ("running" as const) : ("stopped" as const)),
    };
    const onState = vi.fn();
    const controller = new NativeLocalStackController({ stack, userDataDir: root, onState });
    try {
      const starting = controller.start();
      expect(controller.start()).toBe(starting);
      expect((await starting).phase).toBe("ready");
      expect(await controller.matchesDesiredStack()).toBe(true);
      expect(controller.webUrl()).toBe("http://127.0.0.1:43123");
      expect(await readStackWebUrl(path.join(root, "stack"), "fallback")).toBe(controller.webUrl());
      expect(onState.mock.calls.map(([state]) => state.phase)).toEqual(["starting", "ready"]);
      await controller.stop();
      expect(controller.state().phase).toBe("idle");
      expect(await controller.matchesDesiredStack()).toBe(false);
    } finally {
      await stack.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans up after failure and only exposes a fixed UI message", async () => {
    const stack = {
      start: vi.fn(async () => {
        throw new Error("private credentials");
      }),
      stop: vi.fn(async () => {}),
      status: () => "failed" as const,
    };
    const controller = new NativeLocalStackController({ stack, userDataDir: "/unused" });
    expect((await controller.start()).phase).toBe("failed");
    expect(controller.state().message).not.toContain("private");
    expect(stack.stop).toHaveBeenCalledOnce();
  });
});
