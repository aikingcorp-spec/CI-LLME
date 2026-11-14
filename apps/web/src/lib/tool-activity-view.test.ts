import type { MessageBlock } from "@rakazo/contracts";
import { withToolStepOutcomes } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  currentWork,
  isToolOnlyNarration,
  messageHasVisibleBlocks,
  recordedStepResult,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "./tool-activity-view";

const stepsBlock: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const stepsNoDuration: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const textBlock: MessageBlock = { kind: "text", text: "Here you go." };
const liveActivity: MessageBlock = { kind: "progress", text: "Using shell", activity: true };
const narration: MessageBlock = { kind: "progress", text: "Let me check that." };

describe("tool step count", () => {
  it("sums each row's count", () => {
    expect(toolStepCount([{ count: 1 }, { count: 3 }])).toBe(4);
    expect(toolStepCount([])).toBe(0);
  });
});

describe("tool card render decisions", () => {
  it("renders only steps blocks, and only when the preference is on", () => {
    expect(shouldRenderToolCard(stepsBlock, true)).toBe(true);
    expect(shouldRenderToolCard(stepsBlock, false)).toBe(false);
    expect(shouldRenderToolCard(textBlock, true)).toBe(false);
    expect(shouldRenderToolCard(liveActivity, true)).toBe(false);
  });

  it("keeps text order and drops hidden activity per preference", () => {
    const blocks = [textBlock, stepsBlock, liveActivity, narration];
    expect(renderableMessageBlocks(blocks, true)).toEqual([textBlock, stepsBlock, narration]);
    expect(renderableMessageBlocks(blocks, false)).toEqual([textBlock, narration]);
  });

  it("never surfaces a progress block marked as activity", () => {
    expect(messageHasVisibleBlocks([liveActivity], true)).toBe(false);
    expect(messageHasVisibleBlocks([liveActivity], false)).toBe(false);
  });

  it("keeps a steps-only message visible only when the preference is on", () => {
    expect(messageHasVisibleBlocks([stepsNoDuration], true)).toBe(true);
    expect(messageHasVisibleBlocks([stepsNoDuration], false)).toBe(false);
    expect(messageHasVisibleBlocks([textBlock], false)).toBe(true);
  });
});

describe("tool-only narration", () => {
  it("is true for a live run that has only called tools, and for a steps-only message", () => {
    expect(isToolOnlyNarration([liveActivity, stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock, stepsNoDuration], true)).toBe(true);
  });

  it("is false once the bot has written something, or when tool cards are hidden", () => {
    expect(isToolOnlyNarration([stepsBlock, textBlock], true)).toBe(false);
    expect(isToolOnlyNarration([narration, liveActivity, stepsBlock], true)).toBe(false);
    expect(isToolOnlyNarration([liveActivity, stepsBlock], false)).toBe(false);
    expect(isToolOnlyNarration([liveActivity], true)).toBe(false);
  });
});

describe("current work from structured events", () => {
  const command = "rm -rf /home/aiking";
  const live = (blocks: MessageBlock[]) => [{ id: "progress:run", blocks }];

  it("uses the tool id and drops the command on that line", () => {
    expect(
      currentWork(
        live([
          {
            kind: "progress",
            text: `Running: ${command}`,
            activity: true,
            pendingToolNames: ["shell"],
          },
        ]),
        false,
      ),
    ).toEqual({ kind: "tool", toolId: "shell" });
  });

  it("follows a tool switch to the latest id", () => {
    expect(
      currentWork(
        live([
          {
            kind: "progress",
            text: "Reading /home/aiking/secret.txt",
            activity: true,
            pendingToolNames: ["shell", "read_file"],
          },
        ]),
        false,
      ),
    ).toEqual({ kind: "tool", toolId: "read_file" });
  });

  it("stays generic when the activity line has no tool id", () => {
    expect(
      currentWork(live([{ kind: "progress", text: `Running: ${command}`, activity: true }]), false),
    ).toEqual({ kind: "generic" });
  });

  it("returns the line only when detail is requested", () => {
    const blocks: MessageBlock[] = [
      {
        kind: "progress",
        text: `Running: ${command}`,
        activity: true,
        pendingToolNames: ["shell"],
      },
    ];
    expect(currentWork(live(blocks), true)).toEqual({
      kind: "detail",
      line: `Running: ${command}`,
    });
  });

  it("reads a recorded outcome once the activity line is gone", () => {
    const blocks = (result: "succeeded" | "failed" | "stopped"): MessageBlock[] => [
      { kind: "steps", steps: [{ label: "Read file", count: 1, outcomes: { [result]: 1 } }] },
    ];
    expect(currentWork(live(blocks("succeeded")), false)).toEqual({
      kind: "finished",
      label: "Read file",
    });
    expect(currentWork(live(blocks("failed")), false)).toEqual({
      kind: "failed",
      label: "Read file",
    });
    expect(currentWork(live(blocks("stopped")), false)).toEqual({
      kind: "stopped",
      label: "Read file",
    });
    expect(
      recordedStepResult({ label: "Read file", count: 2, outcomes: { failed: 1, succeeded: 1 } }),
    ).toBe("failed");
  });

  it("does not treat an unstructured note as the current tool", () => {
    expect(
      currentWork(
        live([
          { kind: "steps", steps: [{ label: "Shell", count: 1, outcomes: { succeeded: 1 } }] },
          { kind: "progress", text: "Checking the totals.", activity: true },
        ]),
        false,
      ),
    ).toEqual({ kind: "generic" });
  });
});

describe("a retired import checklist", () => {
  const item = { kind: "routine" as const, routineId: "routine-1", name: "morning" };
  const retired: MessageBlock[] = [
    // As Undo leaves it now, and as a marked one written before items were emptied.
    { kind: "import_setup", items: [], undone: true },
    { kind: "import_setup", items: [item], undone: true },
    { kind: "import_setup", items: [] },
  ];

  it("gives its message no row, in either tool-activity mode", () => {
    for (const block of retired) {
      for (const showToolActivity of [true, false]) {
        expect(messageHasVisibleBlocks([block], showToolActivity)).toBe(false);
        expect(renderableMessageBlocks([block], showToolActivity)).toEqual([]);
      }
    }
  });

  it("still shows a live checklist and anything beside a retired one", () => {
    const live: MessageBlock = { kind: "import_setup", items: [item] };
    expect(messageHasVisibleBlocks([live], false)).toBe(true);
    expect(renderableMessageBlocks([retired[0]!, textBlock], false)).toEqual([textBlock]);
  });
});

it.each(["succeeded", "failed", "stopped"] as const)(
  "does not finish a grouped row while another call is pending after %s",
  (outcome) => {
    const blocks = withToolStepOutcomes(
      [{ kind: "steps", steps: [{ label: "Shell", count: 2 }] }],
      [
        { label: "Shell", outcome },
        { label: "Shell", outcome: undefined },
      ],
    );
    expect(currentWork([{ id: "progress:run", blocks }], false)).toEqual({
      kind: "step",
      label: "Shell",
    });
  },
);
