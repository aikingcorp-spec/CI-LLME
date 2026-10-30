import { t } from "@lingui/core/macro";
import { humanizeToolName } from "@rakazo/core";
import { builtinToolLabel, builtinToolNames } from "./builtin-tool-labels";

// The server writes these status lines in English (describeToolActivity in the adapters); the
// client shows them in the reader's language. Order matters: a specific prefix comes first.
type Line = readonly [pattern: RegExp, render: (...groups: string[]) => string];
const LINES: readonly Line[] = [
  [/^Running on your computer: (.*)$/su, (detail) => t`Running on your computer: ${detail}`],
  [/^Running: (.*)$/su, (detail) => t`Running: ${detail}`],
  [/^Rendering a chart$/u, () => t`Rendering a chart`],
  [/^Connecting MCP server: (.*)$/su, (detail) => t`Connecting MCP server: ${detail}`],
  [/^Looking at the screen$/u, () => t`Looking at the screen`],
  [/^Opening page: (.*)$/su, (detail) => t`Opening page: ${detail}`],
  [/^Reading the page$/u, () => t`Reading the page`],
  [/^Reading page: (.*)$/su, (detail) => t`Reading page: ${detail}`],
  [/^Reading skill: (.*)$/su, (detail) => t`Reading skill: ${detail}`],
  [/^Reading (.+) from (.+)$/su, (file, name) => t`Reading ${file} from ${name}`],
  [/^Reading (.*)$/su, (detail) => t`Reading ${detail}`],
  [/^Writing (.*)$/su, (detail) => t`Writing ${detail}`],
  [/^Listing (.*)$/su, (detail) => t`Listing ${detail}`],
  [/^Attaching (.*)$/su, (detail) => t`Attaching ${detail}`],
  [/^Opening (.*)$/su, (detail) => t`Opening ${detail}`],
  [/^Using the page$/u, () => t`Using the page`],
  [/^Operating the computer$/u, () => t`Operating the computer`],
  [/^Delegating to helper: (.*)$/su, (detail) => t`Delegating to helper: ${detail}`],
  [/^Creating space: (.*)$/su, (detail) => t`Creating space: ${detail}`],
  [/^Checking your bots$/u, () => t`Checking your bots`],
  [/^Creating group: (.*)$/su, (detail) => t`Creating group: ${detail}`],
  [/^Updating group: (.*)$/su, (detail) => t`Updating group: ${detail}`],
  [/^Organizing the sidebar$/u, () => t`Organizing the sidebar`],
  [/^Rewriting a bot's instructions$/u, () => t`Rewriting a bot's instructions`],
  [/^Setting a bot's model$/u, () => t`Setting a bot's model`],
  [/^Scheduling routine: (.*)$/su, (detail) => t`Scheduling routine: ${detail}`],
  [/^Saving a note to memory$/u, () => t`Saving a note to memory`],
  [/^Saving shared memory: (.*)$/su, (detail) => t`Saving shared memory: ${detail}`],
  [/^Searching the web: (.*)$/su, (detail) => t`Searching the web: ${detail}`],
  [/^Creating skill: (.*)$/su, (detail) => t`Creating skill: ${detail}`],
  [/^Updating skill: (.*)$/su, (detail) => t`Updating skill: ${detail}`],
  [/^Deleting skill: (.*)$/su, (detail) => t`Deleting skill: ${detail}`],
  [/^Using ([^:\s]+): (.*)$/su, (server, tool) => t`Using ${server}: ${tool}`],
  [
    /^Using (\S+)$/u,
    (name) => {
      const tool = builtinToolLabel(name);
      return t`Using ${tool}`;
    },
  ],
  [/^Using (.+)$/su, (name) => t`Using ${name}`],
  [/^Using $/u, () => t`Using a tool`],
];

// The server trims each line, so a call whose detail is still empty arrives as "Reading" or
// "Searching the web:"; the trailing space it lost is restored before matching.
function render(line: string): string | undefined {
  for (const candidate of [line, `${line} `]) {
    for (const [pattern, render] of LINES) {
      const match = pattern.exec(candidate);
      if (match) return render(...match.slice(1)).trim();
    }
  }
  return undefined;
}

/** Whether the line is one the server writes, so it has a translated form. */
export function isToolActivityLine(line: string): boolean {
  return render(line) !== undefined;
}

/** The live tool status line in the reader's language; unknown text is shown as written. */
export function toolActivityLine(line: string): string {
  return render(line) ?? line;
}

// The approval card text the server writes (approval-ask.ts in the adapters).
const REVIEW = /^Review before (.+)$/su;
const REVIEW_TOOL = /^([a-z][a-z0-9_]*) → (.+)$/su;

/** The approval card's question in the reader's language; other ask text is shown as written. */
export function askCardText(text: string): string {
  const review = REVIEW.exec(text.trim());
  if (!review?.[1]) return text;
  const tool = REVIEW_TOOL.exec(review[1]);
  const action = tool?.[1] && tool[2] ? `${builtinToolLabel(tool[1])} → ${tool[2]}` : review[1];
  return t`Review before ${action}`;
}

/** The built-in tool a recorded step label names; the label is the humanized tool name. */
export function builtinToolOfStepLabel(label: string): string | undefined {
  return builtinToolNames().find((candidate) => humanizeToolName(candidate) === label);
}

/** A built-in tool's step label is shown translated; a connector tool's stays as recorded. */
export function toolStepLabel(label: string): string {
  const name = builtinToolOfStepLabel(label);
  return name ? builtinToolLabel(name) : label;
}
