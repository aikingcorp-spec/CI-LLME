import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMigrationClient } from "./native-migrate.js";
import type { RunProcessResult } from "./native-postgres.js";
import { NativePostgres, PG_BIN_DIR_ENV, runProcess } from "./native-postgres.js";
import { NativeStack } from "./native-stack.js";

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
      "migrate",
      [],
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

describe("in-process migration", () => {
  it("reports a failed migration with a redacted cause and cleans up", async () => {
    const postgres = {
      start: vi.fn(async () => ({
        ...endpoints,
        migrationUrl: "postgres://owner:fakepw@127.0.0.1:1/rakazo",
      })),
      stop: vi.fn(async () => {}),
    };
    const onFailure = vi.fn();
    const stack = new NativeStack({
      postgres,
      dbDir: path.resolve("packages/db"),
      env: {},
      onFailure,
    });
    await expect(stack.start()).rejects.toThrow("The local stack could not start.");
    expect(postgres.stop).toHaveBeenCalledOnce();
    expect(stack.status()).toBe("failed");
    const [stage, error] = onFailure.mock.calls[0]!;
    expect(stage).toBe("migrate");
    expect(String((error as Error).message)).toMatch(/Migration exited with code 1\. stage=migrate/);
    expect(String((error as Error).message)).not.toContain("fakepw");
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
