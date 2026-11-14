// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RemoteHostControls } from "./RemoteSettings";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { variant?: string }) => <button {...props}>{children}</button>,
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
