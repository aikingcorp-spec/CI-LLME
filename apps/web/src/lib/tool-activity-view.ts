import type { MessageBlock } from "@rakazo/contracts";
import { isRetiredImportSetup, isToolActivityBlock } from "@rakazo/core";

export type RecordedStepResult = "succeeded" | "failed" | "stopped";

type RecordedStep = {
  label: string;
  count: number;
  outcomes?: { succeeded?: number; failed?: number; stopped?: number };
};

/** A grouped step finishes only when every call has an outcome. */
export function recordedStepResult(step: RecordedStep): RecordedStepResult | undefined {
  const outcomes = step.outcomes;
  if (!outcomes) return undefined;
  const completed = (outcomes.succeeded ?? 0) + (outcomes.failed ?? 0) + (outcomes.stopped ?? 0);
  if (completed < step.count) return undefined;
  if ((outcomes.failed ?? 0) > 0) return "failed";
  if ((outcomes.stopped ?? 0) > 0) return "stopped";
  if ((outcomes.succeeded ?? 0) > 0) return "succeeded";
  return undefined;
}

/**
 * What the live glyph may say. A tool id or a recorded step is structured.
 * Free-form activity text is not a status unless the reader opted into detail.
 */
export type CurrentWork =
  | { kind: "tool"; toolId: string }
  | { kind: "step"; label: string }
  | { kind: "finished"; label: string }
  | { kind: "failed"; label: string }
  | { kind: "stopped"; label: string }
  | { kind: "detail"; line: string }
  | { kind: "generic" };

export function currentWork(
  messages: readonly { id: string; blocks: readonly MessageBlock[] }[],
  showDetail: boolean,
): CurrentWork {
  const live = messages.findLast((message) => message.id.startsWith("progress:"));
  if (!live) return { kind: "generic" };
  const tail = live.blocks.at(-1);
  const progress = tail?.kind === "progress" ? tail : undefined;
  const pending = progress?.pendingToolNames?.findLast((name) => name.trim().length > 0);
  const activityText =
    progress?.activity === true && progress.text.trim() ? progress.text.trim() : undefined;
  if (showDetail && activityText) return { kind: "detail", line: activityText };
  if (pending) return { kind: "tool", toolId: pending };
  if (activityText) return { kind: "generic" };
  const steps = live.blocks.findLast((block) => block.kind === "steps");
  const step = steps?.kind === "steps" ? steps.steps.at(-1) : undefined;
  if (!step?.label.trim()) return { kind: "generic" };
  const result = recordedStepResult(step);
  if (result === "failed") return { kind: "failed", label: step.label };
  if (result === "stopped") return { kind: "stopped", label: step.label };
  if (result === "succeeded") return { kind: "finished", label: step.label };
  return { kind: "step", label: step.label };
}

/** Number of tool calls behind a steps block: the sum of each row's count. */
export function toolStepCount(steps: readonly { count: number }[]): number {
  return steps.reduce((total, step) => total + step.count, 0);
}

/**
 * Only a `steps` block becomes a card, and only when the preference is on.
 * A `progress` block marked `activity: true` never renders, in either mode.
 */
export function shouldRenderToolCard(block: MessageBlock, showToolActivity: boolean): boolean {
  return showToolActivity && block.kind === "steps";
}

/** Blocks that survive into a message render. */
export function renderableMessageBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): MessageBlock[] {
  return blocks.filter((block) => isShown(block, showToolActivity));
}

function isShown(block: MessageBlock, showToolActivity: boolean): boolean {
  if (isRetiredImportSetup(block)) return false;
  return !isToolActivityBlock(block) || shouldRenderToolCard(block, showToolActivity);
}

/**
 * True when a bot message's only visible blocks are tool cards, such as a live run that
 * has called tools but not written anything yet. Such a message renders as slim lines
 * between messages instead of inside a chat bubble.
 */
export function isToolOnlyNarration(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  const visible = renderableMessageBlocks(blocks, showToolActivity);
  return visible.length > 0 && visible.every((block) => block.kind === "steps");
}

/** True when a message still has at least one block to show under the preference. */
export function messageHasVisibleBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
): boolean {
  return blocks.some((block) => isShown(block, showToolActivity));
}
