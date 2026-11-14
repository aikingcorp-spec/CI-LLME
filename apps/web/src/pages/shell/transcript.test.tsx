// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { foldPeerReplies } from "@rakazo/core";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { Transcript } from "./transcript";

const stableT = (strings: TemplateStringsArray, ...values: unknown[]) =>
  String.raw(strings, ...values);

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
  useLingui: () => ({ t: stableT }),
}));

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

let container: HTMLDivElement;
let root: Root;
let scrollRef: RefObject<HTMLDivElement | null>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  scrollRef = { current: container };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

let seq = 0;
function at(minutes: number) {
  return new Date(2026, 0, 1, 10, minutes).toISOString();
}

function textMessage(id: string, role: "user" | "bot", text: string): ThreadMessage {
  seq += 1;
  return {
    id,
    threadId: "thread",
    seq,
    role,
    createdAt: at(seq),
    blocks: [{ kind: "text", text }],
  };
}

function liveMessage(text: string): ThreadMessage {
  return {
    id: "progress:run",
    threadId: "thread",
    seq: 9999,
    role: "bot",
    createdAt: at(120),
    blocks: [{ kind: "progress", text }],
  };
}

function history(): ThreadMessage[] {
  return [
    textMessage("m1", "user", "Book a weekend in the mountains"),
    textMessage("m2", "bot", "Looking at cabins near Zakopane"),
    textMessage("m3", "bot", "Atlas will pick the dates"),
    textMessage("m4", "user", "Sounds good"),
  ];
}

function baseProps(messages: readonly ThreadMessage[]): ComponentProps<typeof Transcript> {
  return {
    scrollRef,
    scrollRequest: null,
    onScrollRequestHandled: vi.fn(),
    followRequest: 0,
    callHoldsSpeaker: false,
    artifactTarget: { botId: "bot" },
    transcript: foldPeerReplies(messages, { includePeerReceipts: true }),
    showToolActivity: false,
    olderCursor: null,
    unreadAfterSeq: null,
    loadingOlder: false,
    answerableAskIds: new Set<string>(),
    dismissableAskIds: new Set<string>(),
    running: true,
    workingBots: [{ botId: "bot", color: "orange", status: "running" }],
    onLoadOlder: vi.fn(),
    onOpenBot: vi.fn(),
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onMarkUnread: vi.fn(),
    onQuote: vi.fn(),
    onReact: vi.fn(),
    onJumpToMessage: vi.fn(),
    onOpenPeerMessages: vi.fn(),
    peerBot: () => ({ name: "Atlas", color: "orange" }),
    onRefresh: vi.fn(),
    onBotChanged: vi.fn(),
    onAddRoutine: vi.fn(),
    voiceReady: false,
    speakingMessageId: null,
    onSpeak: vi.fn(),
    onOpenComputer: vi.fn(),
    rpc,
  };
}

function render(props: ComponentProps<typeof Transcript>) {
  act(() => root.render(<Transcript {...props} />));
}

it("drops the quote pill when a streaming edit replaces the selected nodes", async () => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, width: 0 }) as DOMRect;
  const historyMessages = history();
  const props = baseProps([...historyMessages, liveMessage("Drafting")]);
  render(props);
  const row = container.querySelector<HTMLElement>('[data-message-id="m2"]')!;
  const select = (needle: string) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && !node.textContent?.includes(needle)) node = walker.nextNode() as Text | null;
    if (!node) throw new Error(`needle ${needle} not found`);
    const range = document.createRange();
    range.setStart(node, node.textContent!.indexOf(needle));
    range.setEnd(node, node.textContent!.indexOf(needle) + needle.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
  };

  select("cabins near");
  expect(document.querySelector("[data-quote-selection]")).not.toBeNull();
  const range = window.getSelection()!.getRangeAt(0);
  expect(range.collapsed).toBe(false);

  // The stream rewrites the message with new markdown structure, replacing
  // the nodes the selection covered.
  const rewritten = historyMessages.map((message) =>
    message.id === "m2"
      ? {
          ...message,
          blocks: [{ kind: "text" as const, text: "Looking at **cabins** near Zakopane" }],
        }
      : message,
  );
  render({
    ...props,
    transcript: foldPeerReplies([...rewritten, liveMessage("Drafting")], {
      includePeerReceipts: true,
    }),
  });

  expect(window.getSelection()!.getRangeAt(0).collapsed).toBe(true);
  expect(document.querySelector("[data-quote-selection]")).toBeNull();
});

it("drops the quote pill when an edit removes only one end of the selection", async () => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, width: 0 }) as DOMRect;
  const messages = history().map((message) =>
    message.id === "m2"
      ? {
          ...message,
          blocks: [{ kind: "text" as const, text: "Looking at **cabins** near Zakopane" }],
        }
      : message,
  );
  const props = baseProps([...messages, liveMessage("Drafting")]);
  render(props);
  const row = container.querySelector<HTMLElement>('[data-message-id="m2"]')!;
  const textNode = (needle: string) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node && !node.textContent?.includes(needle)) node = walker.nextNode() as Text | null;
    if (!node) throw new Error(`needle ${needle} not found`);
    return node;
  };
  const start = textNode("Looking at");
  const end = textNode("near Zakopane");
  const range = document.createRange();
  range.setStart(start, start.textContent!.indexOf("at"));
  range.setEnd(end, end.textContent!.indexOf("near") + "near".length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
  expect(document.querySelector("[data-quote-selection]")).not.toBeNull();

  // An edit replaces only the node holding the start: the range moves without collapsing.
  start.remove();
  render({
    ...props,
    transcript: foldPeerReplies([...messages, liveMessage("Drafting more")], {
      includePeerReceipts: true,
    }),
  });

  expect(window.getSelection()!.getRangeAt(0).collapsed).toBe(false);
  expect(document.querySelector("[data-quote-selection]")).toBeNull();
});

const COMMAND = "rm -rf /home/aiking";
const SECRET_PATH = "/home/aiking/secret.txt";

function progressMessage(blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id: "progress:run",
    threadId: "thread",
    seq: 9999,
    role: "bot",
    createdAt: at(120),
    blocks,
  };
}

function statusText() {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

it("shows the live tool instead of the command or path", () => {
  render(
    baseProps([
      progressMessage([
        {
          kind: "progress",
          text: `Running: ${COMMAND}`,
          activity: true,
          pendingToolNames: ["shell"],
        },
      ]),
    ]),
  );
  const status = statusText();
  expect(status).toContain("Running a task");
  expect(status).not.toContain(COMMAND);
  expect(status).not.toContain("/home/aiking");

  render(
    baseProps([
      progressMessage([
        {
          kind: "progress",
          text: `Reading ${SECRET_PATH}`,
          activity: true,
          pendingToolNames: ["read_file"],
        },
      ]),
    ]),
  );
  const next = statusText();
  expect(next).toContain("Reading a file");
  expect(next).not.toContain(SECRET_PATH);
  expect(next).not.toContain(COMMAND);
});

it("keeps a command hidden when the live line has no tool id", () => {
  render(
    baseProps([
      progressMessage([
        {
          kind: "progress",
          text: `Running: ${COMMAND}`,
          activity: true,
        },
      ]),
    ]),
  );
  const status = statusText();
  expect(status).toContain("Working");
  expect(status).not.toContain(COMMAND);
  expect(status).not.toContain("/home/aiking");
});

it("names a finished, failed, or stopped step from its recorded outcome", () => {
  const step = (outcome: "succeeded" | "failed" | "stopped"): ThreadMessage["blocks"] => [
    {
      kind: "steps",
      steps: [{ label: "Read file", count: 1, outcomes: { [outcome]: 1 } }],
    },
  ];
  render(baseProps([progressMessage(step("succeeded"))]));
  expect(statusText()).toContain("Read file");
  expect(statusText()).toContain("Finished");
  render(baseProps([progressMessage(step("failed"))]));
  expect(statusText()).toContain("Couldn't finish");
  expect(statusText()).toContain("Read file");
  expect(statusText()).not.toContain(SECRET_PATH);
  render(baseProps([progressMessage(step("stopped"))]));
  expect(statusText()).toContain("Stopped");
  expect(statusText()).toContain("Read file");
});

it("does not turn an unstructured note into a tool status", () => {
  const blocks: ThreadMessage["blocks"] = [
    { kind: "steps", steps: [{ label: "Shell", count: 1, outcomes: { succeeded: 1 } }] },
    { kind: "progress", text: "Checking the totals.", activity: true },
  ];
  render(baseProps([progressMessage(blocks)]));
  expect(statusText()).toContain("Working");
  expect(statusText()).not.toContain("Checking the totals");
  expect(statusText()).not.toContain(COMMAND);
  render({ ...baseProps([progressMessage(blocks)]), showToolActivity: true });
  expect(statusText()).toContain("Checking the totals.");
});

it("shows the command only after tool activity is turned on", () => {
  const blocks: ThreadMessage["blocks"] = [
    {
      kind: "progress",
      text: `Running: ${COMMAND}`,
      activity: true,
      pendingToolNames: ["shell"],
    },
  ];
  render({ ...baseProps([progressMessage(blocks)]), showToolActivity: true });
  expect(statusText()).toContain(COMMAND);
});

it("keeps an approval question visible while a command stays off the status line", () => {
  render(
    baseProps([
      {
        ...textMessage("ask-1", "bot", ""),
        blocks: [{ kind: "ask", text: "Approve sending the report?", status: "pending" }],
      },
      progressMessage([
        {
          kind: "progress",
          text: `Running: ${COMMAND}`,
          activity: true,
          pendingToolNames: ["shell"],
        },
      ]),
    ]),
  );
  expect(container.textContent).toContain("Approve sending the report?");
  expect(statusText()).not.toContain(COMMAND);
});

it("keeps Stop on a saved helper while the live command stays hidden", () => {
  const helper: ThreadMessage = {
    id: "card-1",
    threadId: "thread",
    seq: 4,
    role: "bot",
    botId: "bot-1",
    createdAt: at(4),
    blocks: [
      { kind: "subagent", agentId: "scout", name: "scout", task: "venues", status: "running" },
    ],
  };
  render(
    baseProps([
      helper,
      progressMessage([
        {
          kind: "progress",
          text: `Running: ${COMMAND}`,
          activity: true,
          pendingToolNames: ["shell"],
        },
      ]),
    ]),
  );
  const stop = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop",
  );
  expect(stop).toBeTruthy();
  expect(statusText()).not.toContain(COMMAND);
});
