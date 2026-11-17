// @vitest-environment jsdom

import { REMOTE_OFFLINE_AFTER_MS } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRemoteEdition, setRemoteEdition } from "../lib/remote-edition";
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
  list.mockReset();
  list.mockResolvedValue({ kind: "unavailable" as const, devices: [] });
  setRemoteEdition(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { desktop?: object }).desktop;
  setRemoteEdition(undefined);
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
});

it("pauses heartbeat for free edition and re-checks on window focus", async () => {
  vi.useFakeTimers();
  (globalThis as { desktop?: object }).desktop = {};
  list.mockResolvedValueOnce({ kind: "unavailable", edition: "free", devices: [] } as never);
  const unmount = await mount();
  expect(list).toHaveBeenCalledTimes(1);
  expect(getRemoteEdition()).toBe("free");

  await act(async () => {
    vi.advanceTimersByTime(REMOTE_OFFLINE_AFTER_MS);
  });
  expect(list).toHaveBeenCalledTimes(1);

  list.mockResolvedValueOnce({ kind: "unavailable", edition: "team", devices: [] } as never);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(list).toHaveBeenCalledTimes(2);
  expect(getRemoteEdition()).toBe("team");

  await act(async () => {
    vi.advanceTimersByTime(Math.floor(REMOTE_OFFLINE_AFTER_MS / 4));
  });
  expect(list).toHaveBeenCalledTimes(3);
  await unmount();
});
