import path from "node:path";
import { describeFailure } from "./native-diagnostics.js";
import {
  migrateNativeDatabase,
  migrateNativeJobQueue,
  provisionNativeRuntimeRole,
} from "./native-migrate.js";
import type { NativePostgres, RunProcess } from "./native-postgres.js";
import type { NativeServices } from "./native-services.js";

export interface NativeStackEndpoints {
  databaseUrl: string;
  migrationUrl: string;
  webUrl?: string;
}

export type NativeStackStatus =
  | "stopped"
  | "starting"
  | "migrating"
  | "running"
  | "stopping"
  | "failed";

export interface NativeStackOptions {
  postgres: Pick<NativePostgres, "start" | "stop"> & Partial<Pick<NativePostgres, "stopSync">>;
  /** Absolute path to the shared DB package and its existing pg dependency. */
  dbDir: string;
  services?: NativeServices;
  env?: NodeJS.ProcessEnv;
  /** Replaces the in-process migration, for tests of the lifecycle. */
  run?: RunProcess;
  migrationsDir?: string;
  /** Receives the failing stage and the real error; the thrown error stays generic. */
  onFailure?: (stage: NativeStackStage, error: unknown) => void;
  /** Progress marker for diagnostics; never carries paths or secrets. */
  onStage?: (stage: "migrate" | "server") => void;
}

export type NativeStackStage = "cleanup" | "postgres" | "migrate" | "services" | "stopped";

/**
 * The desktop bundle is one ESM file that imports Electron's window APIs, which a utility
 * process cannot load, so migrations run in the main process. They are async database I/O
 * and the app has no window to keep responsive until the stack is up.
 */
const runInProcessMigration: RunProcess = async (_file, _args, options) => {
  const url = options.env.DATABASE_MIGRATION_URL!;
  const dbDir = options.env.RAKAZO_NATIVE_DB_DIR!;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, options.timeoutMs);
  try {
    await migrateNativeDatabase({
      databaseUrl: url,
      dbDir,
      migrationsDir: options.env.RAKAZO_NATIVE_MIGRATIONS_DIR!,
    });
    await migrateNativeJobQueue(url, dbDir);
    await provisionNativeRuntimeRole(url, options.env.RAKAZO_NATIVE_RUNTIME_URL!, dbDir);
    return { code: timedOut ? null : 0, timedOut, stdout: "", stderr: "" };
  } catch (error) {
    return { code: 1, timedOut, stdout: "", stderr: describeFailure("migrate", error) };
  } finally {
    clearTimeout(timer);
  }
};

/** Migration always finishes before runtime services receive the restricted database login. */
export class NativeStack {
  private current: NativeStackStatus = "stopped";
  private endpoints: NativeStackEndpoints | null = null;
  private starting: Promise<NativeStackEndpoints> | null = null;
  private stopping: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private postgresStarted = false;
  private servicesStarted = false;

  constructor(private readonly options: NativeStackOptions) {}

  status(): NativeStackStatus {
    return this.current;
  }

  start(): Promise<NativeStackEndpoints> {
    if (this.starting) return this.starting;
    if (this.endpoints && !this.stopping) return Promise.resolve({ ...this.endpoints });
    const generation = this.generation;
    const attempt = (this.stopping ?? Promise.resolve())
      .then(async () => {
        if (generation !== this.generation) throw new Error("Local stack startup was stopped.");
        return this.startStack(generation);
      })
      .finally(() => {
        if (this.starting === attempt) this.starting = null;
      });
    this.starting = attempt;
    return attempt;
  }

  /** Last resort when the process is exiting and nothing async can finish. */
  stopSync(): void {
    this.options.postgres.stopSync?.();
  }

  stop(): Promise<void> {
    if (this.stopping && !this.starting) return this.stopping;
    this.generation += 1;
    this.controller?.abort();
    const pending = [this.starting, this.stopping];
    this.starting = null;
    this.endpoints = null;
    this.current = "stopping";
    const attempt = Promise.all(pending.map((p) => p?.catch(() => undefined)))
      .then(async () => {
        await this.cleanup();
        this.current = "stopped";
      })
      .catch(() => {
        this.current = "failed";
        throw new Error("The local stack did not stop.");
      })
      .finally(() => {
        if (this.stopping === attempt) this.stopping = null;
      });
    this.stopping = attempt;
    return attempt;
  }

  private async startStack(generation: number): Promise<NativeStackEndpoints> {
    const controller = new AbortController();
    this.controller = controller;
    const checkStopped = () => {
      if (generation !== this.generation) throw new Error("Local stack startup was stopped.");
    };
    let stage: NativeStackStage = "cleanup";
    try {
      // Retry any failed cleanup before creating more processes.
      await this.cleanup();
      checkStopped();
      stage = "postgres";
      this.current = "starting";
      this.postgresStarted = true;
      const pg = await this.options.postgres.start();
      checkStopped();
      stage = "migrate";
      this.current = "migrating";
      this.options.onStage?.("migrate");
      const result = await (this.options.run ?? runInProcessMigration)("migrate", [], {
        cwd: this.options.dbDir,
        env: {
          ...(this.options.env ?? process.env),
          DATABASE_URL: pg.migrationUrl,
          DATABASE_MIGRATION_URL: pg.migrationUrl,
          RAKAZO_NATIVE_RUNTIME_URL: pg.databaseUrl,
          RAKAZO_NATIVE_DB_DIR: this.options.dbDir,
          RAKAZO_NATIVE_MIGRATIONS_DIR:
            this.options.migrationsDir ?? path.join(this.options.dbDir, "prisma", "migrations"),
        },
        timeoutMs: 120_000,
        signal: controller.signal,
      });
      if (result.code !== 0 || result.timedOut)
        throw new Error(
          result.timedOut
            ? "Migration timed out."
            : `Migration exited with code ${result.code}. ${result.stderr}`,
        );
      checkStopped();
      stage = "services";
      this.options.onStage?.("server");
      let webUrl: string | undefined;
      if (this.options.services) {
        this.servicesStarted = true;
        ({ webUrl } = await this.options.services.start({
          DATABASE_URL: pg.databaseUrl,
          SANDBOX_PROVIDER: "desktop",
        }));
      }
      checkStopped();
      this.endpoints = {
        databaseUrl: pg.databaseUrl,
        migrationUrl: pg.migrationUrl,
        ...(webUrl ? { webUrl } : {}),
      };
      this.current = "running";
      return { ...this.endpoints };
    } catch (error) {
      if (generation === this.generation) this.options.onFailure?.(stage, error);
      this.endpoints = null;
      await this.cleanup().catch(() => undefined);
      this.current = "failed";
      // Neither child output nor database URLs belong in errors or logs.
      throw new Error("The local stack could not start.");
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private async cleanup(): Promise<void> {
    let failed = false;
    if (this.servicesStarted) {
      try {
        await this.options.services!.stop();
        this.servicesStarted = false;
      } catch {
        failed = true;
      }
    }
    if (this.postgresStarted) {
      try {
        await this.options.postgres.stop();
        this.postgresStarted = false;
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("The local stack did not stop.");
  }
}
