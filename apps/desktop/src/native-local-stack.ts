import type { DesktopLocalStackState } from "@rakazo/contracts";
import { initialStackState } from "./local-stack.js";
import { writeNativeWebUrl } from "./native-smoke.js";
import type { NativeStack } from "./native-stack.js";
import { strings, stringsFor } from "./strings.js";

/** Keeps the existing setup/menu contract while native startup skips Docker setup. */
export class NativeLocalStackController {
  private current = initialStackState("native");
  private url = "http://127.0.0.1:5173";
  private pending: Promise<DesktopLocalStackState> | null = null;

  constructor(
    private readonly input: {
      stack: Pick<NativeStack, "start" | "stop" | "status">;
      userDataDir: string;
      waitForReady?: (url: string) => Promise<void>;
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
        await this.input.waitForReady?.(webUrl);
        this.url = webUrl;
        this.setState({ ...this.current, phase: "ready" });
      } catch (error) {
        await this.input.stack.stop().catch(() => undefined);
        this.setState({
          ...this.current,
          phase: "failed",
          message: strings().stack.startFailed,
          failure: nativeStartFailureDetail(error),
        });
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

const databaseFailureMessages: Record<string, string> = {
  "data-dir-unsafe":
    "Không thể kiểm tra thư mục dữ liệu. Dữ liệu được giữ nguyên; hãy kiểm tra quyền thư mục hoặc liên hệ hỗ trợ.",
  "data-dir-not-owned":
    "Thư mục dữ liệu thuộc người dùng khác. Dữ liệu được giữ nguyên; hãy kiểm tra quyền sở hữu thư mục.",
  "data-dir-symlink":
    "Thư mục dữ liệu là liên kết tượng trưng. Dữ liệu được giữ nguyên; hãy liên hệ hỗ trợ.",
  "data-dir-version-missing":
    "Thiếu PG_VERSION trong thư mục dữ liệu. Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ.",
  "data-dir-version-unreadable":
    "Không thể đọc PG_VERSION. Dữ liệu được giữ nguyên; hãy kiểm tra quyền thư mục và liên hệ hỗ trợ.",
  "data-dir-version-empty":
    "PG_VERSION trống hoặc không hợp lệ. Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ.",
  "data-dir-incomplete":
    "Thư mục dữ liệu bị thiếu hoặc hỏng (không có base/ hoặc global/). Dữ liệu được giữ nguyên; hãy khôi phục bản sao lưu hoặc liên hệ hỗ trợ.",
  "version-mismatch":
    "Phiên bản dữ liệu PostgreSQL không tương thích. Dữ liệu được giữ nguyên; hãy dùng phiên bản ứng dụng phù hợp hoặc khôi phục bản sao lưu.",
};

export function nativeStartFailureDetail(error: unknown): { code: string; messageVi: string } {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") {
      const messageVi = Object.hasOwn(databaseFailureMessages, current.code)
        ? databaseFailureMessages[current.code]
        : undefined;
      if (messageVi !== undefined) return { code: current.code, messageVi };
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return { code: "start-failed", messageVi: stringsFor("vi").stack.startFailed };
}
