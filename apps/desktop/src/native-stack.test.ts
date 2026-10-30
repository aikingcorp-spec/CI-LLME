import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMigrationClient,
  migrateNativeDatabase,
  migrateNativeJobQueue,
  provisionNativeRuntimeRole,
} from "./native-migrate.js";
import type { RunProcessResult } from "./native-postgres.js";
import { NativePostgres, PG_BIN_DIR_ENV, runProcess } from "./native-postgres.js";
import { NativeStack } from "./native-stack.js";

const utility = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: utility }));

const ok: RunProcessResult = { code: 0, timedOut: false, stdout: "", stderr: "" };
const endpoints = {
  port: 40001,
  databaseUrl: "postgres://runtime:fake@127.0.0.1:40001/rakazo",
  migrationUrl: "postgres://owner:fake@127.0.0.1:40001/rakazo",
};

function fixture(withServices = true) {
  const calls: string[] = [];
  const postgres = {
    start: vi.fn(async () => {
      calls.push("pg.start");
      return endpoints;
    }),
    stop: vi.fn(async () => {
      calls.push("pg.stop");
    }),
  };
  const services = {
    start: vi.fn(async (_env?: Record<string, string>) => {
      calls.push("services.start");
      return { webUrl: "http://127.0.0.1:40002" };
    }),
    stop: vi.fn(async () => {
      calls.push("services.stop");
    }),
  };
  const run = vi.fn(async () => {
    calls.push("migrate");
    return ok;
  });
  const stack = new NativeStack({
    postgres,
    services: withServices ? services : undefined,
    dbDir: "/repo/packages/db",
    env: { DATABASE_URL: "stale", DATABASE_MIGRATION_URL: "stale-owner" },
    migrationCommand: { file: "/prisma/build/index.js", args: ["migrate", "deploy"] },
    run,
  });
  return { stack, postgres, services, run, calls };
}

describe("NativeStack", () => {
  it("migrates with the owner before services start with the runtime login", async () => {
    const f = fixture();
    expect(f.stack.status()).toBe("stopped");
    expect(await f.stack.start()).toEqual({
      databaseUrl: endpoints.databaseUrl,
      migrationUrl: endpoints.migrationUrl,
      webUrl: "http://127.0.0.1:40002",
    });
    expect(f.calls).toEqual(["pg.start", "migrate", "services.start"]);
    expect(f.run).toHaveBeenCalledWith(
      "/prisma/build/index.js",
      ["migrate", "deploy"],
      expect.objectContaining({
        cwd: "/repo/packages/db",
        env: expect.objectContaining({
          DATABASE_URL: endpoints.migrationUrl,
          DATABASE_MIGRATION_URL: endpoints.migrationUrl,
        }),
      }),
    );
    expect(f.services.start).toHaveBeenCalledWith({
      DATABASE_URL: endpoints.databaseUrl,
      SANDBOX_PROVIDER: "desktop",
    });
    expect(f.stack.status()).toBe("running");
    await f.stack.stop();
    expect(f.calls.slice(-2)).toEqual(["services.stop", "pg.stop"]);
    expect(f.stack.status()).toBe("stopped");
  });

  it("supports a database-only stack and idempotent start/stop", async () => {
    const f = fixture(false);
    const first = f.stack.start();
    expect(f.stack.start()).toBe(first);
    const result = await first;
    expect(result).not.toHaveProperty("webUrl");
    result.databaseUrl = "changed";
    expect((await f.stack.start()).databaseUrl).toBe(endpoints.databaseUrl);
    await Promise.all([f.stack.stop(), f.stack.stop()]);
    await f.stack.stop();
    expect(f.postgres.stop).toHaveBeenCalledTimes(1);
    await f.stack.start();
    expect(f.postgres.start).toHaveBeenCalledTimes(2);
    await f.stack.stop();
  });

  it.each(["postgres", "migrate", "services"] as const)(
    "cleans up a partial %s failure and allows retry",
    async (stage) => {
      const f = fixture();
      const error = new Error("private output postgres://owner:fake@localhost/db");
      if (stage === "postgres") f.postgres.start.mockRejectedValueOnce(error);
      if (stage === "migrate") f.run.mockRejectedValueOnce(error);
      if (stage === "services") f.services.start.mockRejectedValueOnce(error);
      await expect(f.stack.start()).rejects.toThrow("The local stack could not start.");
      expect(f.stack.status()).toBe("failed");
      expect(f.calls.at(-1)).toBe("pg.stop");
      if (stage === "services") expect(f.calls.slice(-2)).toEqual(["services.stop", "pg.stop"]);
      else expect(f.services.start).not.toHaveBeenCalled();
      await f.stack.start();
      await f.stack.stop();
    },
  );

  it.each([
    { ...ok, code: 1 },
    { ...ok, timedOut: true },
  ])("cleans up an unsuccessful migration result", async (result) => {
    const f = fixture();
    f.run.mockImplementationOnce(async () => {
      f.calls.push("migrate");
      return result;
    });
    await expect(f.stack.start()).rejects.toThrow("The local stack could not start.");
    expect(f.services.start).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["pg.start", "migrate", "pg.stop"]);
  });

  it("stops postgres even if services fail to stop, and retries failed cleanup", async () => {
    const f = fixture();
    await f.stack.start();
    f.services.stop.mockRejectedValueOnce(new Error("private details"));
    await expect(f.stack.stop()).rejects.toThrow("The local stack did not stop.");
    expect(f.postgres.stop).toHaveBeenCalledOnce();
    expect(f.stack.status()).toBe("failed");
    await f.stack.stop();
    expect(f.services.stop).toHaveBeenCalledTimes(2);
    expect(f.stack.status()).toBe("stopped");
  });

  it("aborts migration, waits for cleanup, then starts a fresh request", async () => {
    const f = fixture();
    let finish!: (result: RunProcessResult) => void;
    f.run.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const starting = f.stack.start();
    const rejected = expect(starting).rejects.toThrow("The local stack could not start.");
    await vi.waitFor(() => expect(f.stack.status()).toBe("migrating"));
    const signal = (
      f.run.mock.calls[0] as unknown as [string, string[], { signal: AbortSignal }]
    )[2].signal;
    const stopping = f.stack.stop();
    expect(signal.aborted).toBe(true);
    const restarted = f.stack.start();
    finish(ok);
    await rejected;
    await stopping;
    await restarted;
    expect(f.calls).toEqual(["pg.start", "pg.stop", "pg.start", "migrate", "services.start"]);
    await f.stack.stop();
  });

  it("does not launch services when stopped during postgres startup", async () => {
    const f = fixture();
    let finish!: (result: typeof endpoints) => void;
    f.postgres.start.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const starting = f.stack.start();
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(f.stack.status()).toBe("starting"));
    const stopping = f.stack.stop();
    finish(endpoints);
    await rejected;
    await stopping;
    expect(f.run).not.toHaveBeenCalled();
    expect(f.services.start).not.toHaveBeenCalled();
    expect(f.stack.status()).toBe("stopped");
  });
});

describe("utility process migration", () => {
  function fixture() {
    const child = new EventEmitter();
    const kill = vi.fn(() => {
      child.emit("exit", 1);
    });
    utility.fork.mockReset().mockReturnValue(Object.assign(child, { kill }));
    const postgres = { start: vi.fn(async () => endpoints), stop: vi.fn(async () => {}) };
    const dbDir = path.resolve("packages/db");
    const stack = new NativeStack({ postgres, dbDir, env: {} });
    return { child, kill, postgres, dbDir, stack };
  }

  it("forks the in-app runner with private output and waits for its exit", async () => {
    const f = fixture();
    const starting = f.stack.start();
    await vi.waitFor(() => expect(utility.fork).toHaveBeenCalledOnce());
    expect(utility.fork).toHaveBeenCalledWith(
      path.join(import.meta.dirname, "main.js"),
      ["--rakazo-native-migrate"],
      {
        cwd: f.dbDir,
        env: expect.objectContaining({
          DATABASE_URL: endpoints.migrationUrl,
          DATABASE_MIGRATION_URL: endpoints.migrationUrl,
        }),
        stdio: "ignore",
      },
    );
    expect(f.stack.status()).toBe("migrating");
    f.child.emit("exit", 0);
    await starting;
    await f.stack.stop();
  });

  it("kills the migration on stop and releases postgres after the utility child exits", async () => {
    const f = fixture();
    const starting = f.stack.start();
    const rejected = expect(starting).rejects.toThrow("The local stack could not start.");
    await vi.waitFor(() => expect(utility.fork).toHaveBeenCalledOnce());
    await f.stack.stop();
    await rejected;
    expect(f.kill).toHaveBeenCalledOnce();
    expect(f.postgres.stop).toHaveBeenCalledOnce();
    expect(f.stack.status()).toBe("stopped");
  });

  it("cleans up a utility process startup error without exposing its output", async () => {
    const f = fixture();
    const starting = f.stack.start();
    const rejected = expect(starting).rejects.toThrow("The local stack could not start.");
    await vi.waitFor(() => expect(utility.fork).toHaveBeenCalledOnce());
    f.child.emit("error", new Error("private child details"));
    await rejected;
    expect(f.postgres.stop).toHaveBeenCalledOnce();
  });
});

it.runIf(
  Boolean(process.env[PG_BIN_DIR_ENV]) && process.platform === "linux" && process.getuid?.() !== 0,
)(
  "deploys the real packages/db migrations on the bundled Postgres",
  async () => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), "rakazo-stack-real-"));
    const dbDir = path.resolve("packages/db");
    const postgres = new NativePostgres({ userDataDir });
    const stack = new NativeStack({
      postgres,
      dbDir,
      run: async (_file, _args, options) => {
        await migrateNativeDatabase({
          databaseUrl: options.env.DATABASE_MIGRATION_URL!,
          dbDir,
          migrationsDir: path.join(dbDir, "prisma", "migrations"),
        });
        await migrateNativeJobQueue(options.env.DATABASE_MIGRATION_URL!, dbDir);
        await provisionNativeRuntimeRole(
          options.env.DATABASE_MIGRATION_URL!,
          options.env.RAKAZO_NATIVE_RUNTIME_URL!,
          dbDir,
        );
        return ok;
      },
    });
    try {
      await stack.start();
      expect(stack.status()).toBe("running");
      const status = await runProcess(
        process.execPath,
        [
          createRequire(path.join(dbDir, "package.json")).resolve("prisma/build/index.js"),
          "migrate",
          "status",
        ],
        {
          cwd: dbDir,
          env: { ...process.env, DATABASE_MIGRATION_URL: (await stack.start()).migrationUrl },
          timeoutMs: 120_000,
        },
      );
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("Database schema is up to date");
      const runtime = createMigrationClient((await stack.start()).databaseUrl, dbDir);
      try {
        await runtime.connect();
        expect(
          (
            await runtime.query(
              "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
            )
          ).rows[0],
        ).toEqual({ rolsuper: false, rolbypassrls: false });
        expect(
          (await runtime.query("SELECT count(*)::int AS count FROM messages")).rows[0]!.count,
        ).toBe(0);
        await runtime.query("SELECT count(*) FROM graphile_worker._private_jobs");
        await expect(runtime.query('SELECT * FROM "_prisma_migrations"')).rejects.toThrow();
      } finally {
        await runtime.end();
      }
      // Deploy is idempotent against the same persisted cluster.
      await stack.stop();
      await stack.start();
    } finally {
      await stack.stop();
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
  180_000,
);
