import type { ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import type * as Core from "@rakazo/core";
import { runThreadSubscription } from "@rakazo/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { endCall, getSnapshot, startCall, toggleMute } from "./call-session";
import type { NativeVoice } from "./native-voice";
import { rpc } from "./rpc";

const native = vi.hoisted(() => ({
  hooks: null as ConstructorParameters<typeof NativeVoice>[0] | null,
  close: vi.fn(),
  reply: vi.fn(),
  mute: vi.fn(),
  start: vi.fn(async () => undefined),
}));
vi.mock("./native-voice", () => ({
  NativeVoice: class {
    close = native.close;
    reply = native.reply;
    mute = native.mute;
    start = native.start;
    constructor(hooks: NonNullable<typeof native.hooks>) {
      native.hooks = hooks;
    }
  },
}));
vi.mock("@rakazo/core", async (original) => ({
  ...(await original<typeof Core>()),
  runThreadSubscription: vi.fn(async () => undefined),
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
}));
vi.mock("./tts", () => ({ speaker: { stop: vi.fn(), speak: vi.fn() } }));
vi.mock("./dictation", () => ({ dictation: { stop: vi.fn() } }));
vi.mock("./rpc", () => ({
  rpc: {
    voice: {
      realtime: {
        status: vi.fn(async () => ({ enabled: true })),
        connect: vi.fn(async () => ({ answer: "v=0" })),
      },
    },
    threads: {
      get: vi.fn(),
      send: vi.fn(async () => ({ runId: "run" })),
      followUp: vi.fn(async () => ({ runId: "run" })),
      endCall: vi.fn(async () => ({ ok: true })),
    },
  },
}));
const snapshot = (
  messages: ThreadMessage[] = [],
  run: ThreadSnapshot["run"] = null,
): ThreadSnapshot => ({
  botId: "bot",
  threadId: "thread",
  cursor: 1,
  olderCursor: null,
  messages,
  run,
});
const botMessage = (id: string, text: string): ThreadMessage =>
  ({
    id,
    role: "bot",
    blocks: [{ kind: "text", text }],
    createdAt: new Date().toISOString(),
  }) as ThreadMessage;

beforeEach(() => {
  endCall();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(rpc.threads.get).mockResolvedValue(snapshot());
});
afterEach(() => {
  endCall();
  vi.useRealTimers();
});
function begin() {
  startCall({ botId: "bot", botName: "Assistant", realtime: true });
  native.hooks!.ready();
}

it("sends a voice delegation to the existing Pi thread and returns only its new reply", async () => {
  vi.mocked(rpc.threads.get).mockResolvedValueOnce(
    snapshot([botMessage("old", "Historical result")]),
  );
  begin();
  await native.hooks!.delegate("intent", "Create two teammates");
  expect(rpc.threads.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      botId: "bot",
      text: "Create two teammates",
      clientNonce: expect.stringMatching(/^call:/),
    }),
  );
  expect(native.reply).not.toHaveBeenCalled();
  vi.mocked(rpc.threads.get).mockResolvedValue(
    snapshot([botMessage("new", "Two teammates created")]),
  );
  await vi.mocked(runThreadSubscription).mock.calls.at(-1)![0].refresh();
  expect(native.reply).toHaveBeenCalledExactlyOnceWith("intent", "Two teammates created");
  toggleMute();
  expect(native.mute).toHaveBeenCalledWith(true);
  endCall();
  expect(native.close).toHaveBeenCalledOnce();
});

it("steers work already running instead of starting another task", async () => {
  vi.mocked(rpc.threads.get).mockResolvedValue(
    snapshot([], { id: "run", status: "running" } as ThreadSnapshot["run"]),
  );
  begin();
  await native.hooks!.delegate("status", "How far have you got?");
  expect(rpc.threads.followUp).toHaveBeenCalledOnce();
  expect(rpc.threads.send).not.toHaveBeenCalled();
});

it("closes provider media when the node authorization heartbeat fails", async () => {
  vi.mocked(rpc.voice.realtime.status).mockRejectedValueOnce(new Error("Expired authorization"));
  begin();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(native.close).toHaveBeenCalledOnce();
  expect(getSnapshot()).toMatchObject({
    muted: true,
    caption: "The computer connection was lost. Hang up and reconnect.",
  });
});

it("ignores a late delegated request after the caller has hung up", async () => {
  begin();
  const oldHooks = native.hooks!;
  endCall();
  await oldHooks.delegate("late", "Create a teammate");
  expect(rpc.threads.send).not.toHaveBeenCalled();
});
