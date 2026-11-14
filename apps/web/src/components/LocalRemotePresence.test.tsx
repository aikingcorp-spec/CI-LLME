// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { LocalRemotePresence } from "./LocalRemotePresence";

const { list } = vi.hoisted(() => ({
  list: vi.fn(async () => ({ kind: "unavailable" as const, devices: [] })),
}));

vi.mock("../lib/rpc", () => ({
  rpc: { remoteHosts: { list } },
}));

vi.mock("../lib/desktop", () => ({
  desktopBridge: () => (globalThis as { desktop?: object }).desktop,
}));

beforeEach(() => {
  list.mockClear();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(<LocalRemotePresence />);
  });
  return async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  };
}

it("stays quiet when the page is not the desktop app", async () => {
  delete (globalThis as { desktop?: object }).desktop;
  const unmount = await mount();
  expect(list).not.toHaveBeenCalled();
  await unmount();
});

it("registers presence while the desktop app is open", async () => {
  (globalThis as { desktop?: object }).desktop = {};
  const unmount = await mount();
  expect(list).toHaveBeenCalledOnce();
  await unmount();
  delete (globalThis as { desktop?: object }).desktop;
});
