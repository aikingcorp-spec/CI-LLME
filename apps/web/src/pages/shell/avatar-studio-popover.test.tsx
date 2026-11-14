// @vitest-environment jsdom

import type { BotAvatarSet } from "@rakazo/contracts";
import { DEFAULT_BOT_AVATAR_COLOR } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { AvatarStudioPopover } from "./avatar-studio-popover";

let container: HTMLDivElement;
let root: Root;
const changed = vi.fn<(value: string, avatarSet?: BotAvatarSet) => void>();

function Harness({
  value: initial,
  avatarSet: initialSet,
}: {
  value: string;
  avatarSet?: BotAvatarSet;
}) {
  const [value, setValue] = useState(initial);
  const [avatarSet, setAvatarSet] = useState(initialSet);
  return (
    <AvatarStudioPopover
      value={value}
      identity="sample-bot"
      avatarSet={avatarSet}
      onChange={(next, nextSet) => {
        changed(next, nextSet);
        setValue(next);
        if (nextSet !== undefined) setAvatarSet(nextSet);
      }}
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  changed.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function render(value: string, avatarSet?: BotAvatarSet, key = "initial") {
  await act(async () => root.render(<Harness key={key} value={value} avatarSet={avatarSet} />));
}

describe("selectable bot icon sets", () => {
  it("opens a legacy product-brand set on VNBot without rewriting saved data", async () => {
    await render("#10B981", "rakazo");
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-avatar]'),
    ).not.toBeNull();
    expect(document.querySelector(".rakazo-logo-avatar")).toBeNull();
    await click("Customize bot avatar");
    expect(button("VNBot").getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector('[data-testid="avatar-studio"] [data-vnbot-avatar]'),
    ).not.toBeNull();
    expect(document.querySelector(".rakazo-logo-avatar")).toBeNull();
    expect(document.querySelector(".rakazo-organic-avatar")).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    const tabs = document.querySelector('[aria-label="Icon set"]')!;
    expect([...tabs.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
      "VNBot",
      "Classic",
    ]);
    await click("Classic");
    await click("VNBot");
    expect(changed).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-avatar]'),
    ).not.toBeNull();
  });

  it("opens organic as Classic without rewriting saved data", async () => {
    await render("#10B981", "organic");
    await click("Customize bot avatar");
    expect(button("Classic").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".rakazo-organic-avatar")).not.toBeNull();
    expect(document.querySelector(".rakazo-logo-avatar")).toBeNull();
    expect(button("wedge")).toBeDefined();
    expect(document.querySelector('[data-testid^="vnbot-shape-"]')).toBeNull();
    expect(changed).not.toHaveBeenCalled();
    await click("VNBot");
    await click("Classic");
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps a legacy product-brand photo until Classic replaces it", async () => {
    const photo = "data:image/png;base64,legacy";
    await render(photo, "rakazo");
    await click("Customize bot avatar");
    expect(button("VNBot").getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector(`[data-testid="avatar-studio-trigger"] img[src="${photo}"]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`[data-testid="avatar-studio"] img[src="${photo}"]`),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-avatar]'),
    ).toBeNull();
    await click("Classic");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Default");
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_BOT_AVATAR_COLOR, "organic");
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
    expect(document.querySelector(".rakazo-organic-avatar")).not.toBeNull();
  });

  it("saves vnbot when a VNBot shape is picked on a legacy product-brand bot", async () => {
    await render("#10B981", "rakazo");
    await click("Customize bot avatar");
    await click("Sen");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith("#10B981::shape_4", "vnbot");
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-shape="sen"]'),
    ).not.toBeNull();
  });

  it("opens a legacy product-brand bot that already has a Classic shape on Classic", async () => {
    await render("#10B981::shape_4", "rakazo");
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] .bot-character-eyes'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-avatar]'),
    ).toBeNull();
    await click("Customize bot avatar");
    expect(button("Classic").getAttribute("aria-selected")).toBe("true");
    expect(button("pebble").getAttribute("aria-pressed")).toBe("true");
    expect(changed).not.toHaveBeenCalled();
    await click("VNBot");
    expect(changed).not.toHaveBeenCalled();
    await click("Sen");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith("#10B981::shape_4", "vnbot");
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-shape="sen"]'),
    ).not.toBeNull();
  });

  it("selects five VNBot shapes, preserves the shape when recolouring and on reload", async () => {
    await render("#10B981", "vnbot");
    await click("Customize bot avatar");
    const tiles = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid^="vnbot-shape-"]'),
    ];
    expect(tiles).toHaveLength(5);
    expect(tiles.map((node) => node.dataset.testid)).toEqual([
      "vnbot-shape-non",
      "vnbot-shape-chung",
      "vnbot-shape-aodai",
      "vnbot-shape-ran",
      "vnbot-shape-sen",
    ]);
    expect(tiles[0]!.getAttribute("aria-label")).toBe("Nón");
    expect(tiles.every((node) => node.querySelector("[data-vnbot-avatar]"))).toBe(true);
    expect(
      [...document.querySelectorAll("button")].some(
        (node) => node.getAttribute("aria-label") === "wedge",
      ),
    ).toBe(false);
    await act(async () => tiles[4]!.click());
    expect(changed).toHaveBeenLastCalledWith("#10B981::shape_4", undefined);
    await click("Color #8B5CF6");
    expect(changed).toHaveBeenLastCalledWith("#8B5CF6::shape_4", undefined);
    await render("#8B5CF6::shape_4", "vnbot", "reload");
    await click("Customize bot avatar");
    expect(
      document.querySelector('[data-testid="vnbot-shape-sen"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-shape="sen"]'),
    ).not.toBeNull();
  });

  it("leaves a photo intact until another set is selected", async () => {
    const photo = "data:image/png;base64,abc";
    await render(photo, "vnbot");
    await click("Customize bot avatar");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Classic");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector(`img[src="${photo}"]`)).not.toBeNull();
    await click("Default");
    expect(changed).toHaveBeenLastCalledWith(DEFAULT_BOT_AVATAR_COLOR, "organic");
    expect(document.querySelector(`img[src="${photo}"]`)).toBeNull();
  });

  it("keeps explicit Classic shapes while changing colour", async () => {
    await render("#A97EFE::shape_2", "organic");
    await click("Customize bot avatar");
    await click("Color #00C972");
    expect(changed).toHaveBeenLastCalledWith("#00C972::shape_2", undefined);
    expect(button("Classic").getAttribute("aria-selected")).toBe("true");
    changed.mockClear();
    await click("VNBot");
    expect(changed).not.toHaveBeenCalled();
  });

  it("switching tabs never changes the saved look of an existing Classic bot", async () => {
    await render("#10B981::shape_2", "organic");
    await click("Customize bot avatar");
    await click("VNBot");
    expect(button("VNBot").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-testid^="vnbot-shape-"]')).not.toBeNull();
    for (const tile of document.querySelectorAll('[data-testid^="vnbot-shape-"]')) {
      expect(tile.getAttribute("aria-pressed")).toBe("false");
    }
    await click("Classic");
    await click("VNBot");
    await click("Classic");
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector("[data-vnbot-avatar]")).toBeNull();
  });

  it("switching tabs never changes the saved look of an existing VNBot bot", async () => {
    await render("#A97EFE::shape_4", "vnbot");
    await click("Customize bot avatar");
    await click("Classic");
    expect(button("Classic").getAttribute("aria-selected")).toBe("true");
    await click("VNBot");
    expect(changed).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="vnbot-shape-sen"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      document.querySelector('[data-testid="avatar-studio-trigger"] [data-vnbot-shape="sen"]'),
    ).not.toBeNull();
  });

  it("saves the other set only once a shape is picked there", async () => {
    await render("#10B981::shape_2", "organic");
    await click("Customize bot avatar");
    await click("VNBot");
    await click("Sen");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith("#10B981::shape_4", "vnbot");
  });
});
