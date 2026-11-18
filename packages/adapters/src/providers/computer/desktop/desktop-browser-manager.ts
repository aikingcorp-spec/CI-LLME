import path from "node:path";
import type {
  AdapterContext,
  ComputerActionRequest,
  ComputerInput,
  ComputerObservation,
  PageBrowserCommand,
  PageBrowserResult,
  ScreenRequest,
  ScreenSession,
} from "@rakazo/adapter-kit";
import { abortableDelay } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import { DesktopBrowserSession } from "./desktop-browser.js";
import { safeBotFolderName } from "./desktop-browser-cdp.js";

export class DesktopBrowserManager {
  private readonly sessions = new Map<string, DesktopBrowserSession>();

  constructor(
    private readonly opts: {
      root?: string;
      browserExecutablePath?: string;
      listenHostname?: string;
    } = {},
  ) {}

  private profileDirFor(botId: string): string {
    const baseRoot = this.opts.root ?? path.join(process.cwd(), "data");
    return path.resolve(baseRoot, "desktop-browsers", safeBotFolderName(botId));
  }

  sessionFor(computerId: string, botId: string, workspaceHome: string): DesktopBrowserSession {
    let session = this.sessions.get(computerId);
    if (!session) {
      session = new DesktopBrowserSession(
        computerId,
        botId,
        workspaceHome,
        this.profileDirFor(botId),
        this.opts.browserExecutablePath,
        this.opts.listenHostname ?? "127.0.0.1",
      );
      this.sessions.set(computerId, session);
    }
    return session;
  }

  existingSession(computerId: string): DesktopBrowserSession | undefined {
    return this.sessions.get(computerId);
  }

  async connectScreen(
    computerId: string,
    botId: string,
    workspaceHome: string,
    request: ScreenRequest,
  ): Promise<ScreenSession> {
    const session = this.sessionFor(computerId, botId, workspaceHome);
    return session.connectScreen(request);
  }

  async setScreenControl(
    computerId: string,
    botId: string,
    workspaceHome: string,
    interactive: boolean,
    controlToken?: string,
  ): Promise<void> {
    const session = this.sessionFor(computerId, botId, workspaceHome);
    await session.setScreenControl(interactive, controlToken);
  }

  async releaseScreen(computerId: string, keepWarm?: boolean): Promise<void> {
    const session = this.sessions.get(computerId);
    if (!session) return;
    await session.releaseScreen({ keepWarm });
  }

  async pageBrowser(
    computerId: string,
    botId: string,
    workspaceHome: string,
    request: PageBrowserCommand,
    context: AdapterContext,
  ): Promise<PageBrowserResult> {
    const session = this.sessionFor(computerId, botId, workspaceHome);
    return session.pageBrowser(request, context);
  }

  async sendInput(
    computerId: string,
    _botId: string,
    _workspaceHome: string,
    input: ComputerInput,
  ): Promise<boolean> {
    const session = this.sessions.get(computerId);
    if (!session?.hasLiveObservation()) return false;
    await session.applyComputerAction(input);
    await bestEffort(
      "capture desktop browser frame after input",
      session.captureAndBroadcastFrame(),
    );
    return true;
  }

  async observe(computerId: string): Promise<ComputerObservation | null> {
    const session = this.sessions.get(computerId);
    if (!session?.hasLiveObservation()) return null;
    await bestEffort(
      "capture desktop browser frame for observe",
      session.captureAndBroadcastFrame(),
    );
    return session.latestCachedObservation();
  }

  async act(
    computerId: string,
    request: ComputerActionRequest,
  ): Promise<{ completed: number; observation?: ComputerObservation } | null> {
    const session = this.sessions.get(computerId);
    if (!session?.hasLiveObservation()) return null;
    for (const action of request.actions) {
      await session.applyComputerAction(action);
    }
    const settleMs = request.settleMs ?? 0;
    if (settleMs > 0) {
      await abortableDelay(Math.min(5_000, settleMs));
    }
    if (request.observe === false) {
      return { completed: request.actions.length };
    }
    await bestEffort(
      "capture desktop browser frame after computer actions",
      session.captureAndBroadcastFrame(),
    );
    const observation = session.latestCachedObservation();
    return {
      completed: request.actions.length,
      ...(observation ? { observation } : {}),
    };
  }

  async stop(computerId: string): Promise<void> {
    const session = this.sessions.get(computerId);
    if (!session) return;
    await session.destroy(false);
    this.sessions.delete(computerId);
  }

  async destroy(computerId: string, deleteProfile: boolean): Promise<void> {
    const session = this.sessions.get(computerId);
    if (!session) return;
    await session.destroy(deleteProfile);
    this.sessions.delete(computerId);
  }
}
