// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({ configured: false, canConfigure: true, available: true }));
const rpc = vi.hoisted(() => ({
  integrationSetup: {
    save: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => ({ ok: true as const })),
  },
}));

vi.mock("../../lib/rpc", () => ({ rpc }));
vi.mock("../../lib/query", () => ({
  useSpaceQueries: () => ({
    integrationSetup: {
      get: {
        queryOptions: () => ({
          queryKey: ["integrationSetup"],
          queryFn: async () => ({
            canConfigure: setup.canConfigure,
            needsSetup: !setup.configured,
            webUrl: "https://vnbot.test/integrations/setup",
            providers: setup.available ? [{ id: "composio", configured: setup.configured }] : [],
          }),
        }),
      },
    },
  }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, i) => text + (i ? String(values[i - 1]) : "") + part, ""),
  }),
}));

import { PersonalComposio } from "./personal-composio";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  setup.configured = false;
  setup.canConfigure = true;
  setup.available = true;
  rpc.integrationSetup.save.mockClear();
  rpc.integrationSetup.remove.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(onSaved = vi.fn(async () => undefined)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PersonalComposio onSaved={onSaved} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return onSaved;
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === text);
}

it("saves a pasted key, collapses the form, and reloads the catalog", async () => {
  const onSaved = await render();
  expect(container.textContent).toContain("Connect with your Composio key");
  const trigger = button("Connect with your Composio key")!;
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "ak_test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Check and save")!.click());
  expect(rpc.integrationSetup.save).toHaveBeenCalledWith({
    provider: "composio",
    apiKey: "ak_test",
  });
  expect(onSaved).toHaveBeenCalledOnce();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(button("Remove key")).toBeUndefined();
});

it("keeps the form open with an alert when saving fails and clears it when typing a new key", async () => {
  rpc.integrationSetup.save.mockRejectedValueOnce(new Error("Invalid API key"));
  const onSaved = await render();
  const trigger = button("Connect with your Composio key")!;
  await act(async () => trigger.click());
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "ak_bad");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Check and save")!.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Invalid API key");
  expect(onSaved).not.toHaveBeenCalled();

  await act(async () => {
    setValue.call(input, "ak_next");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("offers replacing and removing a saved key", async () => {
  setup.configured = true;
  const onSaved = await render();
  expect(container.textContent).toContain("Composio connected");
  expect(container.querySelector("input")?.getAttribute("placeholder")).toBe(
    "Paste a replacement key",
  );
  await act(async () => button("Remove key")!.click());
  expect(rpc.integrationSetup.remove).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
});

it("shows nothing when this server has no integration settings", async () => {
  setup.canConfigure = false;
  setup.available = false;
  await render();
  expect(container.textContent).toBe("");
});

it("tells everyone but the owner only that the key is missing", async () => {
  setup.canConfigure = false;
  await render();
  expect(container.textContent).toBe(
    "The owner of this computer has not added a Composio key yet.",
  );
  expect(container.querySelector("input")).toBeNull();
});

it("shows everyone but the owner nothing once the key is there", async () => {
  setup.canConfigure = false;
  setup.configured = true;
  await render();
  expect(container.textContent).toBe("");
});
