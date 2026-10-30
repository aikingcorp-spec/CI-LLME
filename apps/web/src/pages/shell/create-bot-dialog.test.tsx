// @vitest-environment jsdom

import {
  ORGANIC_AVATAR_LOOKS,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
  seededVnbotBodyColor,
} from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateBotDialogInput } from "./create-bot-dialog";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { CreateBotDialog } from "./create-bot-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onCreate: (input: CreateBotDialogInput) => Promise<void>) {
  await act(async () => {
    root.render(<CreateBotDialog onCancel={() => undefined} onCreate={onCreate} />);
  });
}

function button(name: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Name your Bot"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("CreateBotDialog", () => {
  it("creates only once the name is not blank", async () => {
    const onCreate = vi.fn(async () => undefined);
    await render(onCreate);
    expect(button("Create").disabled).toBe(true);
    await typeName("   ");
    expect(button("Create").disabled).toBe(true);
    await typeName("  Scout  ");
    expect(button("Create").disabled).toBe(false);
  });

  it("defaults new bots to the vnbot set without an organic family override", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    expect(document.querySelector("[data-vnbot-avatar]")).not.toBeNull();
    expect(document.querySelector("[data-vnbot-avatar]")?.getAttribute("data-vnbot-shape")).toBe(
      "non",
    );
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate.mock.lastCall?.[0]).toMatchObject({ name: "Scout", avatarSet: "vnbot" });
    expect(onCreate.mock.lastCall?.[0]).not.toHaveProperty("avatarFamily");
    const input = onCreate.mock.lastCall![0];
    expect(input.id).toMatch(/^c[a-z0-9]{24}$/);
    expect(input.color).toBe(`${seededVnbotBodyColor(input.id!)}::shape_0`);
  });

  it("preserves an explicitly chosen colour through a failed create and retry", async () => {
    const onCreate = vi
      .fn(async (_input: CreateBotDialogInput) => undefined)
      .mockRejectedValueOnce(new Error("Try again"));
    await render(onCreate);
    await click(button("Color #10B981"));
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate.mock.lastCall?.[0]).toMatchObject({
      avatarSet: "vnbot",
      color: "#10B981::shape_0",
    });
    await click(button("Create"));
    expect(onCreate.mock.lastCall?.[0]).toMatchObject({
      avatarSet: "vnbot",
      color: "#10B981::shape_0",
    });
  });

  it("sends the organic family the preview draws", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await click(button("Classic"));
    expect(document.querySelectorAll(".rakazo-organic-avatar")).toHaveLength(
      ORGANIC_AVATAR_LOOKS.length + 1,
    );
    for (const key of SHIPPED_BOT_AVATAR_SHAPE_KEYS) expect(button(key)).toBeDefined();
    expect(document.querySelector('[data-testid^="vnbot-shape-"]')).toBeNull();
    await click(button("Shape 2"));
    await click(button("Color #10B981"));
    const preview = document.querySelector(".rakazo-organic-avatar");
    const family = Number(preview?.getAttribute("data-shape-family"));
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate).toHaveBeenCalledWith({
      name: "Scout",
      color: "#10B981",
      avatarFamily: family,
      avatarSet: "organic",
    });
    expect(family).toBe(ORGANIC_AVATAR_LOOKS[1]);
  });

  it("sends a studio shape without an organic family", async () => {
    const onCreate = vi.fn(async (_input: CreateBotDialogInput) => undefined);
    await render(onCreate);
    await click(button("Classic"));
    await click(button("Color #F97316"));
    await click(button("wedge"));
    await typeName("Scout");
    await click(button("Create"));
    expect(onCreate).toHaveBeenCalledWith({
      name: "Scout",
      color: "#F97316::shape_1",
      avatarSet: "organic",
    });
  });

  it("shows the error and stays open when creating fails", async () => {
    await render(async () => {
      throw new Error("Bot limit reached");
    });
    await typeName("Scout");
    await click(button("Create"));
    expect(document.querySelector('[data-testid="create-bot-error"]')?.textContent).toBe(
      "Bot limit reached",
    );
    expect(document.querySelector('[data-testid="create-bot-dialog"]')).not.toBeNull();
  });
});

describe("importing instead", () => {
  it("offers Import only when the parent handles it", async () => {
    await render(async () => undefined);
    expect(document.querySelector('[data-testid="create-bot-import"]')).toBeNull();

    const onImport = vi.fn();
    await act(async () => {
      root.render(
        <CreateBotDialog
          onCancel={() => undefined}
          onCreate={async () => undefined}
          onImport={onImport}
        />,
      );
    });
    await act(async () => button("Import an agent").click());
    expect(onImport).toHaveBeenCalledTimes(1);
  });
});

it("retains the VNBot preview identity, selected shape and colour through a retry", async () => {
  const onCreate = vi
    .fn(async (_input: CreateBotDialogInput) => undefined)
    .mockRejectedValueOnce(new Error("Try again"));
  await render(onCreate);
  expect([...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
    "VNBot",
    "Classic",
  ]);
  const tiles = [...document.querySelectorAll<HTMLButtonElement>('[data-testid^="vnbot-shape-"]')];
  expect(tiles).toHaveLength(5);
  expect(tiles[0]!.dataset.testid).toBe("vnbot-shape-non");
  await click(tiles[3]!);
  await click(button("Color #10B981"));
  await typeName("First name");
  await click(button("Create"));
  const first = onCreate.mock.lastCall![0];
  expect(first).toMatchObject({ avatarSet: "vnbot", color: "#10B981::shape_3" });
  expect(first.id).toMatch(/^c[a-z0-9]{24}$/);
  expect(document.querySelector('[data-vnbot-shape="ran"]')).not.toBeNull();
  await typeName("Retry name");
  await click(button("Create"));
  expect(onCreate.mock.lastCall![0]).toMatchObject({ id: first.id, color: first.color });
});
