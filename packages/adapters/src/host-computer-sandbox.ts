import type {
  AdapterContext,
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  WorkspaceDirectoryRequest,
} from "@rakazo/adapter-kit";
import { SandboxFileTooLargeError, SandboxRequestRejectedError } from "@rakazo/adapter-kit";
import { boundedSandboxCommandTimeoutMs } from "@rakazo/core/node/sandbox-command";
import { boundedComputerActions } from "./computer-support.js";
import type {
  HostComputerEnvironment,
  HostComputerFrame,
  HostComputerRequest,
} from "./host-computer-protocol.js";
import {
  HOST_COMPUTER_MAX_BYTES,
  HOST_COMPUTER_MAX_FILE_BYTES,
  hostComputerDeadlineMs,
  hostComputerFileTooLargeLimit,
} from "./host-computer-protocol.js";
import { describeDesktopSandbox } from "./providers/computer/desktop/desktop-sandbox.js";
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

/** Authenticated native host transport. Commands are never retried after a lost response. */
export class HostComputerSandbox implements SandboxProvider {
  readonly pageBrowser?: SandboxProvider["pageBrowser"];

  constructor(
    private readonly url: string,
    private readonly token: string,
    options?: { enablePageBrowser?: boolean },
  ) {
    if (options?.enablePageBrowser) {
      this.pageBrowser = (computer, request, context) =>
        this.runHostPageBrowser(computer, request, context);
    }
  }
  describe() {
    return describeDesktopSandbox();
  }

  private async *request<T>(input: HostComputerRequest, context: AdapterContext): AsyncIterable<T> {
    if (!this.url || !this.token)
      throw new Error("Local computer access requires the desktop app. Enable it in the app menu.");
    const body = JSON.stringify({ ...input, runId: context.runId });
    if (Buffer.byteLength(body) > HOST_COMPUTER_MAX_BYTES)
      throw new Error("Local computer request is too large");
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(hostComputerDeadlineMs(input)),
    ]);
    const response = await fetch(new URL("/computer", this.url), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body,
      signal,
      redirect: "error",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        "Local computer unavailable. Open the desktop app and enable local computer access.",
      );
    }
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          signal.throwIfAborted();
          if (newline > HOST_COMPUTER_MAX_BYTES)
            throw new Error("Local computer response is too large");
          const frame = JSON.parse(pending.slice(0, newline)) as HostComputerFrame<T>;
          pending = pending.slice(newline + 1);
          if ("error" in frame) {
            const maxBytes = hostComputerFileTooLargeLimit(frame.error);
            if (maxBytes !== undefined) throw new SandboxFileTooLargeError(maxBytes);
            if (frame.error === "sandbox rejected browser request") {
              throw new SandboxRequestRejectedError();
            }
            throw new Error(frame.error);
          }
          if ("heartbeat" in frame) {
            newline = pending.indexOf("\n");
            continue;
          }
          if ("done" in frame) {
            return;
          }
          yield frame.value;
          newline = pending.indexOf("\n");
        }
        if (pending.length > HOST_COMPUTER_MAX_BYTES)
          throw new Error("Local computer response is too large");
      }
      throw new Error("Local computer disconnected. Check the result before retrying.");
    } finally {
      signal.removeEventListener("abort", abort);
      const cancellation = reader.cancel().catch(() => undefined);
      if (!signal.aborted) await cancellation;
      reader.releaseLock();
    }
  }
  /** One request outside a computer's lifecycle, such as screen control of this computer. */
  stream<T>(input: HostComputerRequest, signal: AbortSignal): AsyncIterable<T> {
    return this.request<T>(input, {
      operationId: "host-computer",
      traceId: "host-computer",
      spaceId: "local",
      userId: "local",
      runId: input.runId,
      signal,
    });
  }
  private async one<T>(input: HostComputerRequest, context: AdapterContext): Promise<T> {
    let result: T | undefined;
    for await (const value of this.request<T>(input, context)) result = value;
    return result as T;
  }
  environment(computer: ComputerRef, context: AdapterContext) {
    return this.one<HostComputerEnvironment>(
      { method: "environment", botId: computer.botId },
      context,
    );
  }
  provision(input: { botId: string; homePath: string }, context: AdapterContext) {
    return this.one<ComputerRef>({ method: "provision", botId: input.botId }, context);
  }
  async prepare(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "prepare", botId: computer.botId }, context);
  }
  isRunning(computer: ComputerRef, context: AdapterContext) {
    return this.one<boolean>({ method: "isRunning", botId: computer.botId }, context);
  }
  execute(computer: ComputerRef, command: CommandRequest, context: AdapterContext) {
    return this.request<ProcessEvent>(
      {
        method: "execute",
        botId: computer.botId,
        command: { ...command, timeoutMs: boundedSandboxCommandTimeoutMs(command.timeoutMs) },
      },
      context,
    );
  }
  workspaceDirectories(
    computer: ComputerRef,
    directories: WorkspaceDirectoryRequest,
    context: AdapterContext,
  ) {
    return this.one<string[]>(
      { method: "workspaceDirectories", botId: computer.botId, directories },
      context,
    );
  }
  async cancelRunWork(
    computer: ComputerRef,
    _computerId: string,
    runId: string,
    context: AdapterContext,
  ) {
    await this.one({ method: "cancelRunWork", botId: computer.botId, targetRunId: runId }, context);
  }
  listFiles(computer: ComputerRef, path: string, context: AdapterContext) {
    return this.one<ComputerFileEntry[]>(
      { method: "listFiles", botId: computer.botId, path },
      context,
    );
  }
  async readFile(
    computer: ComputerRef,
    path: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ) {
    const content = await this.one<string>(
      {
        method: "readFile",
        botId: computer.botId,
        path,
        maxBytes: Math.min(
          options?.maxBytes ?? HOST_COMPUTER_MAX_FILE_BYTES,
          HOST_COMPUTER_MAX_FILE_BYTES,
        ),
      },
      context,
    );
    return new Uint8Array(Buffer.from(content, "base64"));
  }
  async writeFile(computer: ComputerRef, file: PortableFile, context: AdapterContext) {
    await this.one(
      {
        method: "writeFile",
        botId: computer.botId,
        file: { ...file, content: Buffer.from(file.content).toString("base64") },
      },
      context,
    );
  }
  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    for await (const file of this.request<{ path: string; content: string; executable?: boolean }>(
      { method: "exportWorkspace", botId: computer.botId },
      context,
    )) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      yield { ...file, content: new Uint8Array(Buffer.from(file.content, "base64")) };
    }
  }
  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ) {
    for await (const file of files) {
      if (shouldSkipPortableWorkspaceFile(file.path)) continue;
      await this.writeFile(computer, file, context);
    }
  }
  snapshot(computer: ComputerRef, context: AdapterContext) {
    return this.one<{ id: string; createdAt: string }>(
      { method: "snapshot", botId: computer.botId },
      context,
    );
  }
  async stop(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "stop", botId: computer.botId }, context);
  }
  async destroy(computer: ComputerRef, context: AdapterContext) {
    await this.one({ method: "destroy", botId: computer.botId }, context);
  }
  runHostPageBrowser(
    computer: ComputerRef,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    return this.one<PageBrowserResult>(
      {
        method: "pageBrowser",
        botId: computer.botId,
        browserRequest: request as unknown as Record<string, unknown>,
      },
      context,
    );
  }
  async connectScreen(
    computer?: ComputerRef,
    request?: ScreenRequest,
    context?: AdapterContext,
  ): Promise<ScreenSession> {
    if (!computer || !request || !context) {
      throw new Error(
        "Local screen control is unavailable. Use commands to work with files and apps.",
      );
    }
    const res = await this.one<{
      url: string | null;
      mimeType: string;
      singleUseSignIn?: { screen: string };
    }>(
      {
        method: "connectScreen",
        botId: computer.botId,
        screenRequest: {
          view: request.view,
          ...(request.interactive !== undefined ? { interactive: request.interactive } : {}),
          ...(request.controlToken !== undefined ? { controlToken: request.controlToken } : {}),
        },
      },
      context,
    );
    let screenUrl = res.url;
    if (screenUrl && this.url) {
      try {
        const parsedScreen = new URL(screenUrl);
        const parsedBridge = new URL(this.url);
        if (parsedScreen.hostname === "127.0.0.1" && parsedBridge.hostname) {
          parsedScreen.hostname = parsedBridge.hostname;
          screenUrl = parsedScreen.toString();
        }
      } catch {
        /* keep original screenUrl */
      }
    }
    return {
      url: screenUrl,
      mimeType: res.mimeType,
      ...(res.singleUseSignIn ? { singleUseSignIn: res.singleUseSignIn } : {}),
      close: async () => undefined,
    };
  }
  async setScreenControl(
    computer: ComputerRef,
    interactive: boolean,
    context: AdapterContext,
    controlToken?: string,
  ): Promise<void> {
    await this.one(
      {
        method: "setScreenControl",
        botId: computer.botId,
        interactive,
        ...(controlToken !== undefined ? { controlToken } : {}),
      },
      context,
    );
  }
  async releaseScreen(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const keepScreenWarm = Boolean(
      context.keepScreenWarm && !context.cancelRunWork && !context.signal.aborted,
    );
    await this.one(
      {
        method: "releaseScreen",
        botId: computer.botId,
        keepScreenWarm,
      },
      context,
    );
  }
  async sendInput(
    computer?: ComputerRef,
    input?: ComputerInput,
    lease?: ControlLeaseRef,
    context?: AdapterContext,
  ): Promise<void> {
    if (!computer || !input || !lease || !context) {
      throw new Error("Local screen control is unavailable");
    }
    await this.one(
      {
        method: "sendInput",
        botId: computer.botId,
        input: input as unknown as Record<string, unknown>,
        lease,
      },
      context,
    );
  }
  async observe(computer?: ComputerRef, context?: AdapterContext): Promise<ComputerObservation> {
    if (!computer || !context) {
      throw new Error("Local screen control is unavailable");
    }
    const raw = await this.one<Omit<ComputerObservation, "image"> & { image: string }>(
      { method: "observe", botId: computer.botId },
      context,
    );
    return {
      ...raw,
      image: new Uint8Array(Buffer.from(raw.image, "base64")),
    };
  }
  async act(
    computer?: ComputerRef,
    request?: ComputerActionRequest,
    context?: AdapterContext,
  ): Promise<ComputerActionResult> {
    if (!computer || !request || !context) {
      throw new Error("Local screen control is unavailable");
    }
    const actions = boundedComputerActions(request.actions);
    const raw = await this.one<{
      completed: number;
      observation?: Omit<ComputerObservation, "image"> & { image: string };
    }>(
      {
        method: "act",
        botId: computer.botId,
        actionRequest: {
          actions: actions as unknown as Record<string, unknown>[],
          ...(request.observe !== undefined ? { observe: request.observe } : {}),
          ...(request.settleMs !== undefined ? { settleMs: request.settleMs } : {}),
        },
      },
      context,
    );
    return {
      completed: raw.completed,
      ...(raw.observation
        ? {
            observation: {
              ...raw.observation,
              image: new Uint8Array(Buffer.from(raw.observation.image, "base64")),
            },
          }
        : {}),
    };
  }
}
