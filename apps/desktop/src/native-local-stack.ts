import type { DesktopLocalStackState } from "@rakazo/contracts";
import { initialStackState } from "./local-stack.js";
import { writeNativeWebUrl } from "./native-smoke.js";
import type { NativeStack } from "./native-stack.js";
import { strings } from "./strings.js";

/** Keeps the existing setup/menu contract while native startup skips Docker setup. */
export class NativeLocalStackController {
  private current = initialStackState("native");
  private url = "http://127.0.0.1:5173";
  private pending: Promise<DesktopLocalStackState> | null = null;

  constructor(
    private readonly input: {
      stack: Pick<NativeStack, "start" | "stop" | "status">;
      userDataDir: string;
      onState?: (state: DesktopLocalStackState) => void;
    },
  ) {}

  webUrl() {
    return this.url;
  }
  state() {
    return this.current;
  }
  async matchesDesiredStack() {
    return this.input.stack.status() === "running";
  }
  abort() {
    void this.stop().catch(() => undefined);
  }

  start(): Promise<DesktopLocalStackState> {
    if (this.pending) return this.pending;
    this.setState({ ...this.current, phase: "starting", message: null });
    const pending = (async () => {
      try {
        const { webUrl } = await this.input.stack.start();
        if (!webUrl) throw new Error("Local web address missing.");
        await writeNativeWebUrl(this.input.userDataDir, webUrl);
        this.url = webUrl;
        this.setState({ ...this.current, phase: "ready" });
      } catch {
        await this.input.stack.stop().catch(() => undefined);
        this.setState({ ...this.current, phase: "failed", message: strings().stack.startFailed });
      }
      return this.current;
    })().finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  async stop() {
    await this.input.stack.stop();
    this.setState(initialStackState("native"));
    return this.current;
  }

  private setState(state: DesktopLocalStackState) {
    this.current = state;
    this.input.onState?.(state);
  }
}
