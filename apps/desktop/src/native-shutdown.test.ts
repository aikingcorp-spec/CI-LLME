import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installNativeShutdown } from "./native-shutdown.js";

function setup(stop: () => Promise<void>, timeoutMs = 50) {
  const proc = new EventEmitter();
  const exit = vi.fn();
  const stopSync = vi.fn();
  const dispose = installNativeShutdown({ proc, stop, stopSync, exit, timeoutMs });
  const settled = () =>
    new Promise<void>((resolve) => {
      const record = exit.getMockImplementation();
      exit.mockImplementation((code: number) => {
        record?.(code);
        resolve();
      });
    });
  return { proc, exit, stopSync, dispose, settled };
}

describe("installNativeShutdown", () => {
  it.each(["SIGTERM", "SIGINT", "SIGHUP"])("stops the stack, then exits, on %s", async (signal) => {
    const order: string[] = [];
    const { proc, exit, stopSync, settled } = setup(async () => {
      order.push("stop");
    });
    exit.mockImplementation(() => order.push("exit"));
    const done = settled();
    proc.emit(signal);
    await done;
    expect(order).toEqual(["stop", "exit"]);
    expect(stopSync).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second signal while stopping", async () => {
    const stop = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const { proc, exit, settled } = setup(stop);
    const done = settled();
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    await done;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the synchronous stop when the stack fails to stop", async () => {
    const { proc, stopSync, exit, settled } = setup(() => Promise.reject(new Error("no")));
    const done = settled();
    proc.emit("SIGTERM");
    await done;
    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("falls back to the synchronous stop when the stack hangs", async () => {
    const { proc, stopSync, settled } = setup(() => new Promise<void>(() => undefined), 20);
    const done = settled();
    proc.emit("SIGTERM");
    await done;
    expect(stopSync).toHaveBeenCalledTimes(1);
  });

  it("runs the synchronous stop on process exit and can be removed", () => {
    const { proc, stopSync, exit, dispose } = setup(async () => undefined);
    proc.emit("exit");
    expect(stopSync).toHaveBeenCalledTimes(1);
    dispose();
    proc.emit("exit");
    proc.emit("SIGTERM");
    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
