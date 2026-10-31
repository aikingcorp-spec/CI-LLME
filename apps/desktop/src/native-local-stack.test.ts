import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readStackWebUrl } from "./local-stack.js";
import { NativeLocalStackController, nativeStartFailureDetail } from "./native-local-stack.js";
import { NativePostgresError } from "./native-postgres.js";
import { NativeStack } from "./native-stack.js";

describe("native local stack setup contract", () => {
  it("does not report ready until the local web page is reachable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-native-controller-"));
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onState = vi.fn();
    const controller = new NativeLocalStackController({
      stack: {
        start: async () => ({ webUrl: "http://127.0.0.1:43123" }),
        stop: async () => {},
        status: () => "running" as const,
      },
      userDataDir: root,
      waitForReady: () => ready,
      onState,
    });
    try {
      const starting = controller.start();
      await vi.waitFor(() => expect(onState).toHaveBeenCalled());
      expect(controller.state().phase).toBe("starting");
      release();
      expect((await starting).phase).toBe("ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("carries a real stack database refusal into setup state", async () => {
    const postgres = {
      start: vi.fn(async () => {
        throw new NativePostgresError(
          "data-dir-version-missing",
          "Thiếu PG_VERSION trong thư mục dữ liệu.",
          { cause: new Error("private child output") },
        );
      }),
      stop: vi.fn(async () => {}),
    };
    const stack = new NativeStack({ postgres, dbDir: "/unused" });
    const controller = new NativeLocalStackController({ stack, userDataDir: "/unused" });

    const state = await controller.start();
    expect(state.failure).toEqual({
      code: "data-dir-version-missing",
      messageVi: expect.stringContaining("Thiếu PG_VERSION"),
    });
    expect(state.failure?.messageVi).not.toContain("private");
  });

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
    expect(controller.state().failure).toEqual({
      code: "start-failed",
      messageVi: expect.any(String),
    });
    expect(controller.state().failure?.messageVi).not.toContain("private");
    expect(structuredClone(controller.state())).toEqual(controller.state());
    expect(stack.stop).toHaveBeenCalledOnce();
  });

  it("shows the specific Vietnamese database safety reason in setup", async () => {
    const reason = new NativePostgresError(
      "data-dir-version-missing",
      "Thiếu PG_VERSION. Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu.",
    );
    const stack = {
      start: vi.fn(async () => {
        throw reason;
      }),
      stop: vi.fn(async () => {}),
      status: () => "failed" as const,
    };
    const controller = new NativeLocalStackController({ stack, userDataDir: "/unused" });
    expect((await controller.start()).failure?.messageVi).toContain(
      "Thiếu PG_VERSION trong thư mục dữ liệu",
    );
    expect(controller.state().failure?.messageVi).not.toBe(reason.message);
    expect(nativeStartFailureDetail(new Error("private credentials")).messageVi).not.toContain(
      "private",
    );
  });

  it.each([
    ["data-dir-not-owned", "thuộc người dùng khác"],
    ["data-dir-symlink", "liên kết tượng trưng"],
    ["data-dir-version-unreadable", "Không thể đọc PG_VERSION"],
    ["data-dir-version-empty", "PG_VERSION trống"],
    ["data-dir-incomplete", "không có base/ hoặc global/"],
    ["version-mismatch", "không tương thích"],
  ] as const)("maps %s to a fixed Vietnamese reason", (code, expected) => {
    const detail = nativeStartFailureDetail(
      new Error("outer", { cause: { code, message: "private credentials" } }),
    );
    expect(detail.code).toBe(code);
    expect(detail.messageVi).toContain(expected);
    expect(detail.messageVi).toContain("Dữ liệu được giữ nguyên");
    expect(detail.messageVi).not.toContain("private");
    expect(structuredClone(detail)).toEqual(detail);
  });

  it("uses a safe fallback for an unknown code", () => {
    expect(
      nativeStartFailureDetail({ code: "private-code", message: "private credentials" }),
    ).toEqual({
      code: "start-failed",
      messageVi: expect.any(String),
    });
  });

  it("maps a plain error object without an Error prototype", () => {
    expect(nativeStartFailureDetail({ code: "version-mismatch", message: "private" })).toEqual({
      code: "version-mismatch",
      messageVi: expect.stringContaining("không tương thích"),
    });
  });
});
