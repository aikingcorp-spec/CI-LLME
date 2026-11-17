import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { expect, it } from "vitest";
import { createNativeProcess } from "./native-process.js";

it("starts, stops and restarts a real owned child without deleting its files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-process-test-"));
  const marker = path.join(root, "persisted");
  const readyFile = path.join(root, "ready");
  const service = createNativeProcess({
    executable: process.execPath,
    args: [
      "-e",
      "require('node:fs').writeFileSync('persisted', 'test'); require('node:fs').writeFileSync('ready', 'test'); setInterval(() => {}, 1000)",
    ],
    cwd: root,
    env: {},
    startupTimeoutMs: 3000,
    async ready(signal) {
      while (!signal.aborted) {
        try {
          await access(readyFile);
          return;
        } catch {}
        await setTimeout(10, undefined, { signal });
      }
      signal.throwIfAborted();
    },
  });
  try {
    await service.start(new AbortController().signal);
    await service.stop();
    await expect(access(marker)).resolves.toBeUndefined();
    await rm(readyFile);
    await service.start(new AbortController().signal);
    await service.stop();
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a missing executable and permits cleanup", async () => {
  const service = createNativeProcess({
    executable: path.join(tmpdir(), "missing-native-runtime-test", "executable"),
    args: [],
    cwd: tmpdir(),
    env: {},
    async ready(signal) {
      await setTimeout(3000, undefined, { signal });
    },
  });
  try {
    await expect(service.start(new AbortController().signal)).rejects.toThrow(
      "did not become ready",
    );
  } finally {
    await service.stop();
  }
});
