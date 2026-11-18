// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RemoteHostControls, RemoteSettings } from "./RemoteSettings";

const translate = (strings: TemplateStringsArray, ...values: unknown[]) =>
  strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`);

const lingui = { t: translate };

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => lingui,
}));

const remoteHosts = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
  rpc: { remoteHosts },
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    render: _render,
    ...props
  }: ComponentProps<"button"> & { variant?: string; render?: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
}));

const portal = {
  kind: "unavailable" as const,
  devices: [
    {
      deviceId: "computer-a",
      logicalHost: "ha",
      remoteEnabled: false,
      state: "off" as const,
    },
  ],
};

it("asks before moving remote onto a computer that is already in use", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onSet = vi.fn(async (_deviceId: string, _enabled: boolean, confirmed: boolean) =>
    confirmed
      ? {
          kind: "moved" as const,
          changed: true,
          interruptedDeviceId: "computer-b",
          portal,
        }
      : {
          kind: "needs-confirmation" as const,
          changed: false,
          interruptedDeviceId: "computer-b",
          portal,
        },
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<RemoteHostControls portal={portal} pending={false} onSet={onSet} />);
    });
    expect(container.textContent).toContain("Kết nối từ xa");
    expect(container.textContent).toContain("Chưa bật");
    expect(container.textContent).not.toMatch(/tunnel/i);
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-toggle-computer-a"]',
    );
    if (!toggle) throw new Error("Missing remote switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle.click());
    expect(onSet).toHaveBeenCalledWith("computer-a", true, false);
    expect(container.textContent).toContain("Máy kia sẽ mất kết nối từ xa.");
    const confirm = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-move-confirm"]',
    );
    if (!confirm) throw new Error("Missing move confirmation");
    await act(async () => confirm.click());
    expect(onSet).toHaveBeenLastCalledWith("computer-a", true, true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows the translated error banner when loading computers fails and retries", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  remoteHosts.list.mockReset();
  remoteHosts.list.mockRejectedValueOnce(new Error("offline"));
  remoteHosts.list.mockResolvedValueOnce(portal);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<RemoteSettings />);
    });
    await act(flush);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Không tải được danh sách máy.");
    const retry = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Thử lại",
    );
    if (!retry) throw new Error("Missing retry button");
    await act(async () => retry.click());
    await act(flush);
    expect(remoteHosts.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="remote-settings"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
