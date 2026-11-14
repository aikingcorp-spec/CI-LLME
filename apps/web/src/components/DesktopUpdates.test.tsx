// @vitest-environment jsdom

import type { DesktopUpdateState } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
  toast: { custom: vi.fn(), dismiss: vi.fn() },
}));

import { DesktopUpdateSection, DesktopUpdatesProvider } from "./DesktopUpdates";

const idle: DesktopUpdateState = {
  phase: "idle",
  currentVersion: "0.4.0",
  availableVersion: null,
  percent: null,
  message: null,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DesktopUpdatesProvider>
        <DesktopUpdateSection />
      </DesktopUpdatesProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the signed desktop check on the bridge version", async () => {
  const check = vi.fn(async () => ({ ...idle, checkedAt: "2026-01-01T00:01:00.000Z" }));
  vi.stubGlobal("rakazoDesktop", {
    update: { state: async () => idle, check, install: vi.fn() },
  });
  const { container, cleanup } = await render();
  try {
    expect(container.textContent).toContain("v0.4.0");
    expect(container.textContent).toContain("Desktop app");
    expect(container.textContent).not.toContain("Up to date");
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Check for updates",
    );
    if (!button) throw new Error("Missing Check for updates");
    await act(async () => {
      button.click();
      button.click();
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Up to date");
  } finally {
    await cleanup();
  }
});

it("renders nothing in the desktop section when there is no bridge", async () => {
  const { container, cleanup } = await render();
  try {
    expect(container.querySelector('[data-testid="desktop-update-settings"]')).toBeNull();
  } finally {
    await cleanup();
  }
});
