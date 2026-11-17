import { smokeLog } from "./native-smoke.js";

/** Desktop composition supplies the existing database and service adapters. */
export interface NativeRuntimeService {
  /** Resolves only after readiness, rejects on failure or cancellation. */
  start(signal: AbortSignal): Promise<void>;
  /** Stops owned processes and waits for exit. Must also clean up a failed start. */
  stop(): Promise<void>;
}

export interface NativeRuntimeOptions {
  postgres: NativeRuntimeService;
  /** Use the approved upstream migration entry point, never a second migration runner. */
  migrate(signal: AbortSignal): Promise<void>;
  api: NativeRuntimeService;
  worker: NativeRuntimeService;
  /** Origin of the existing web server, including its API and websocket routing. */
  origin: string;
}

export interface NativeBootResult {
  origin: string;
  readiness: "ready";
}

export type NativeRuntimeStatus = "stopped" | "starting" | "ready" | "stopping" | "failed";

/** One local host owns this lifecycle; unrelated hosts never share its serialization. */
export class NativeRuntime {
  private readonly options: NativeRuntimeOptions;
  private readonly origin: string;
  private state: NativeRuntimeStatus = "stopped";
  private pending: Promise<NativeBootResult> | undefined;
  private stopping: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private owned: NativeRuntimeService[] = [];

  constructor(options: NativeRuntimeOptions) {
    const url = new URL(options.origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Native runtime requires a loopback HTTP origin.");
    }
    this.options = options;
    this.origin = url.origin;
  }

  status(): NativeRuntimeStatus {
    return this.state;
  }

  start(): Promise<NativeBootResult> {
    if (this.stopping) return Promise.reject(new Error("Native runtime is stopping."));
    if (this.pending) return this.pending;
    if (this.state === "ready") return Promise.resolve(this.result());
    const controller = new AbortController();
    this.controller = controller;
    this.state = "starting";
    const pending = this.boot(controller.signal).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    this.pending = pending;
    return pending;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.controller?.abort();
    this.state = "stopping";
    const pending = this.pending;
    const stopping = (async () => {
      await pending?.catch(() => undefined);
      try {
        await this.cleanup();
        this.state = "stopped";
      } catch {
        this.state = "failed";
        throw new Error("Native runtime cleanup failed.");
      }
    })().finally(() => {
      if (this.stopping === stopping) this.stopping = undefined;
    });
    this.stopping = stopping;
    return stopping;
  }

  private result(): NativeBootResult {
    return { origin: this.origin, readiness: "ready" };
  }

  private async boot(signal: AbortSignal): Promise<NativeBootResult> {
    try {
      // Retry retained cleanup before starting replacements.
      await this.cleanup();
      signal.throwIfAborted();
      smokeLog("RAKAZO_DESKTOP_SMOKE service=postgres");
      await this.startService(this.options.postgres, signal);
      smokeLog("RAKAZO_DESKTOP_SMOKE service=migrate");
      await this.options.migrate(signal);
      signal.throwIfAborted();
      smokeLog("RAKAZO_DESKTOP_SMOKE service=api");
      await this.startService(this.options.api, signal);
      smokeLog("RAKAZO_DESKTOP_SMOKE service=worker");
      await this.startService(this.options.worker, signal);
      this.state = "ready";
      return this.result();
    } catch (error) {
      smokeLog(
        `RAKAZO_DESKTOP_SMOKE runtime=${error instanceof Error ? error.message : "unknown"}`,
      );
      this.state = "failed";
      await this.cleanup().catch(() => undefined);
      // Child output and connection strings must not escape through UI errors.
      throw new Error("Native runtime could not start.");
    }
  }

  private async startService(service: NativeRuntimeService, signal: AbortSignal) {
    signal.throwIfAborted();
    this.owned.push(service);
    await service.start(signal);
    signal.throwIfAborted();
  }

  private async cleanup(): Promise<void> {
    // Do not stop Postgres while a dependent process might still be writing.
    while (this.owned.length) {
      const service = this.owned[this.owned.length - 1];
      if (!service) break;
      await service.stop();
      this.owned.pop();
    }
  }
}
