// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { BotCapabilityMap, CAPABILITY_TOOLS, toggleCapability } from "./bot-capability-map";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

describe("toggleCapability", () => {
  it("turns a whole group off and on without touching other tools", () => {
    const off = toggleCapability(["shell"], "web", false);
    expect(off).toEqual(["shell", "web_search", "web_fetch"]);
    expect(toggleCapability(off, "web", true)).toEqual(["shell"]);
    expect(toggleCapability(["web_search"], "web", false)).toEqual(["web_search", "web_fetch"]);
  });

  it("only groups real built-in tools, each in one group", () => {
    const all = Object.values(CAPABILITY_TOOLS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

it("shows each capability as a labelled switch and saves the change", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const onChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(<BotCapabilityMap disabled={["web_fetch"]} saving={false} onChange={onChange} />),
    );
    const rows = [...host.querySelectorAll("li")];
    expect(rows.map((row) => row.querySelector("label")?.textContent)).toEqual([
      "Search the web",
      "Use a browser",
      "Read and write files",
      "Use the computer",
      "Make images and videos",
      "Remember things",
      "Add tools and apps",
    ]);
    const web = host.querySelector<HTMLElement>(
      `#${CSS.escape(rows[0]!.querySelector("label")!.htmlFor)}`,
    )!;
    expect(web.getAttribute("aria-checked") ?? String((web as HTMLInputElement).checked)).toBe(
      "false",
    );
    act(() => web.click());
    expect(onChange).toHaveBeenCalledWith([]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
