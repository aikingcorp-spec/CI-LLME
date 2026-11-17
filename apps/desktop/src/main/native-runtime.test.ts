import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_NATIVE_DIRECTORY,
  CURRENT_NATIVE_LAYOUT_ID,
  CURRENT_NATIVE_POSTGRES_MAJOR,
  checkNativeClusterVersion,
  inspectNativeProfile,
  NATIVE_POSTGRES_MAJOR,
  nativePostgresLayout,
} from "./native-postgres-layout.js";
import { NativeRuntime } from "./native-runtime.js";

function fixture(overrides: { workerFails?: boolean; stopFails?: boolean } = {}) {
  const events: string[] = [];
  let stopFails = overrides.stopFails;
  const service = (name: string) => ({
    async start() {
      events.push(`start:${name}`);
      if (name === "worker" && overrides.workerFails) throw new Error("private output");
    },
    async stop() {
      events.push(`stop:${name}`);
      if (name === "worker" && stopFails) {
        stopFails = false;
        throw new Error("private output");
      }
    },
  });
  const runtime = new NativeRuntime({
    postgres: service("postgres"),
    migrate: async () => {
      events.push("migrate");
    },
    api: service("api"),
    worker: service("worker"),
    origin: "http://127.0.0.1:45678",
  });
  return { runtime, events };
}

describe("native lifecycle contract", () => {
  it("waits for all readiness boundaries and restarts in dependency order", async () => {
    const { runtime, events } = fixture();
    const first = runtime.start();
    expect(runtime.start()).toBe(first);
    await expect(first).resolves.toEqual({ origin: "http://127.0.0.1:45678", readiness: "ready" });
    await runtime.stop();
    expect(events).toEqual([
      "start:postgres",
      "migrate",
      "start:api",
      "start:worker",
      "stop:worker",
      "stop:api",
      "stop:postgres",
    ]);
    await runtime.start();
    expect(runtime.status()).toBe("ready");
    await runtime.stop();
  });

  it("cleans a partially started service and hides its output", async () => {
    const { runtime, events } = fixture({ workerFails: true });
    await expect(runtime.start()).rejects.toThrow(/^Native runtime could not start\.$/);
    expect(events.slice(-3)).toEqual(["stop:worker", "stop:api", "stop:postgres"]);
    expect(runtime.status()).toBe("failed");
  });

  it("retains Postgres when a dependent process cannot stop, then retries cleanup", async () => {
    const { runtime, events } = fixture({ stopFails: true });
    await runtime.start();
    await expect(runtime.stop()).rejects.toThrow("cleanup failed");
    expect(events).not.toContain("stop:postgres");
    await runtime.stop();
    expect(events.slice(-3)).toEqual(["stop:worker", "stop:api", "stop:postgres"]);
  });

  it("cancels startup before migrations and joins concurrent shutdown", async () => {
    let entered: (() => void) | undefined;
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const events: string[] = [];
    const runtime = new NativeRuntime({
      postgres: {
        async start(signal) {
          entered?.();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
        async stop() {
          events.push("stopped");
        },
      },
      async migrate() {
        events.push("migrated");
      },
      api: { async start() {}, async stop() {} },
      worker: { async start() {}, async stop() {} },
      origin: "http://127.0.0.1:45678",
    });
    const boot = runtime.start();
    const rejected = expect(boot).rejects.toThrow("could not start");
    await starting;
    const stopped = runtime.stop();
    expect(runtime.stop()).toBe(stopped);
    await expect(runtime.start()).rejects.toThrow("stopping");
    await stopped;
    await rejected;
    expect(events).toEqual(["stopped"]);
    expect(runtime.status()).toBe("stopped");
  });
});

describe("native cluster compatibility", () => {
  it("keeps the fresh install directory distinct from the audited cluster", () => {
    expect(NATIVE_POSTGRES_MAJOR).toBe("16");
    expect(CURRENT_NATIVE_POSTGRES_MAJOR).toBe("18");
    expect(CURRENT_NATIVE_DIRECTORY).not.toBe("pg");
  });

  it("preserves the audited Windows profile layout", () => {
    expect(
      nativePostgresLayout({
        userDataDir: "C:\\profile\\VNBot",
        binDir: "C:\\bundle\\pg",
        platform: "win32",
      }),
    ).toMatchObject({
      dataDir: "C:\\profile\\VNBot\\pg\\data",
      ownerPasswordFile: "C:\\profile\\VNBot\\pg\\.owner-password",
      postgres: "C:\\bundle\\pg\\postgres.exe",
    });
  });

  it("checks real version files without changing existing clusters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-layout-test-"));
    const data = path.join(root, "data");
    try {
      await expect(checkNativeClusterVersion(data)).resolves.toBe("new");
      await mkdir(data);
      await expect(checkNativeClusterVersion(data)).rejects.toThrow("Cannot read");
      await writeFile(path.join(data, "PG_VERSION"), "16\n");
      await expect(checkNativeClusterVersion(data)).resolves.toBe("existing");
      await writeFile(path.join(data, "PG_VERSION"), "18\n");
      await expect(checkNativeClusterVersion(data)).rejects.toThrow("approval");
      expect(await readFile(path.join(data, "PG_VERSION"), "utf8")).toBe("18\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not open a PostgreSQL 16 profile and does not upgrade it in place", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-profile-"));
    const version = path.join(root, "pg", "data", "PG_VERSION");
    try {
      await expect(inspectNativeProfile(root)).resolves.toEqual({ kind: "fresh" });
      await mkdir(path.dirname(version), { recursive: true });
      await writeFile(version, "16\n");
      await expect(inspectNativeProfile(root)).resolves.toEqual({
        kind: "legacy",
        migration: "copy-only",
        open: false,
      });
      expect(await readFile(version, "utf8")).toBe("16\n");
      await expect(readdir(root)).resolves.toEqual(["pg"]);
      await writeFile(version, "18\n");
      await expect(inspectNativeProfile(root)).resolves.toEqual({ kind: "blocked", open: false });
      expect(await readFile(version, "utf8")).toBe("18\n");
      await rm(path.join(root, "pg"), { recursive: true });
      const current = path.join(root, CURRENT_NATIVE_DIRECTORY);
      await mkdir(current);
      await writeFile(path.join(current, "layout"), `${CURRENT_NATIVE_LAYOUT_ID}\n`);
      await expect(inspectNativeProfile(root)).resolves.toEqual({ kind: "current" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
