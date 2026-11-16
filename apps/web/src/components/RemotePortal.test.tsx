// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryUserProvider } from "../lib/query";
import { rememberedComputerKey } from "../lib/remembered-computer";
import { RemotePortalPage, RemotePortalView } from "./RemotePortal";

const { list, enter } = vi.hoisted(() => ({ list: vi.fn(), enter: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { remoteHosts: { list, enter } } }));
vi.mock("./PageAccountMenu", () => ({
  PageAccountMenu: () => (
    <button type="button" data-testid="account-menu">
      Account
    </button>
  ),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: translate }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

function translate(parts: TemplateStringsArray) {
  return parts.join("");
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const off = {
  deviceId: "a",
  logicalHost: "ha",
  remoteEnabled: false,
  state: "off" as const,
};
const ready = {
  deviceId: "b",
  logicalHost: "hb",
  remoteEnabled: true,
  state: "ready" as const,
};

function page(userId: string | null) {
  return (
    <QueryUserProvider value={userId}>
      <RemotePortalPage />
    </QueryUserProvider>
  );
}

function preferenceKey(userId: string, origin = window.location.origin) {
  const key = rememberedComputerKey(userId, origin);
  if (key === null) throw new Error("Missing preference key");
  return key;
}

function stubAssign() {
  const origin = window.location.origin;
  const assign = vi.fn();
  vi.stubGlobal("location", { assign, origin });
  return assign;
}

async function render(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  async function show(next: ReactNode) {
    await act(async () => {
      root.render(next);
    });
  }
  await show(node);
  return {
    container,
    rerender: show,
    unmount: async () => {
      await act(async () => root.unmount());
    },
  };
}

it("opens the only ready computer and still lists the one that is off", async () => {
  const onOpen = vi.fn();
  const view = await render(
    <RemotePortalView
      portal={{ kind: "open", deviceId: "b", logicalHost: "hb", devices: [ready, off] }}
      onOpen={onOpen}
    />,
  );
  expect(view.container.querySelector("[data-testid='remote-portal-open']")?.textContent).toBe(
    "hb",
  );
  expect(view.container.textContent).toContain("Sẵn sàng");
  expect(view.container.textContent).toContain("Chưa bật");
  expect(view.container.textContent).not.toMatch(/tunnel/i);
  expect(onOpen).toHaveBeenCalledWith("b");
  await view.unmount();
});

it("asks which ready computer to open when more than one is ready", async () => {
  const onOpen = vi.fn();
  const other = { ...ready, deviceId: "c", logicalHost: "hc" };
  const view = await render(
    <RemotePortalView portal={{ kind: "choose", devices: [ready, other] }} onOpen={onOpen} />,
  );
  expect(view.container.querySelector("[data-testid='remote-portal-open']")).toBeNull();
  const pick = view.container.querySelector<HTMLButtonElement>(
    "[data-testid='remote-portal-pick-c']",
  );
  if (!pick) throw new Error("Missing computer choice");
  await act(async () => pick.click());
  expect(onOpen).toHaveBeenCalledWith("c");
  await view.unmount();
});

it("shows an offline computer without opening it", async () => {
  const view = await render(
    <RemotePortalView
      portal={{
        kind: "unavailable",
        devices: [{ ...ready, state: "offline", remoteEnabled: true }],
      }}
    />,
  );
  expect(view.container.textContent).toContain("Ngoại tuyến");
  expect(view.container.querySelector("[data-testid='remote-portal-open']")).toBeNull();
  await view.unmount();
});

it("keeps the account menu available while the computer list has not responded", async () => {
  list.mockReturnValue(new Promise(() => {}));
  const view = await render(<RemotePortalPage />);
  expect(view.container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
  expect(view.container.querySelector('[role="status"]')).not.toBeNull();
  await view.unmount();
});
it("keeps an exit on errors and retries loading the list", async () => {
  list
    .mockRejectedValueOnce(new TypeError("Network"))
    .mockResolvedValueOnce({ kind: "unavailable", devices: [] });
  const view = await render(<RemotePortalPage />);
  expect(view.container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  const retry = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Thử lại",
  )!;
  await act(async () => retry.click());
  expect(list).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector('[data-testid="remote-portal-empty"] a')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
  await view.unmount();
});
it("keeps the list and account exit after opening a computer fails", async () => {
  list.mockResolvedValue({ kind: "open", deviceId: "b", logicalHost: "hb", devices: [ready] });
  enter.mockRejectedValue(new TypeError("Network"));
  const view = await render(<RemotePortalPage />);
  expect(enter).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
  expect(view.container.querySelector('[data-testid="remote-portal-pick-b"]')).not.toBeNull();
  await view.unmount();
});

const stateLabel = {
  off: "Chưa bật",
  offline: "Ngoại tuyến",
  error: "Lỗi",
  connecting: "Đang kết nối",
} as const;

it.each(Object.keys(stateLabel) as (keyof typeof stateLabel)[])(
  "does not open another computer when the remembered one is %s",
  async (state) => {
    const userId = "user-a";
    localStorage.setItem(preferenceKey(userId), JSON.stringify({ deviceId: "a" }));
    const remembered = {
      ...ready,
      deviceId: "a",
      logicalHost: "ha",
      remoteEnabled: state !== "off",
      state,
    };
    list.mockResolvedValue({
      kind: "open",
      deviceId: "b",
      logicalHost: "hb",
      devices: [remembered, ready],
    });
    enter.mockReturnValue(new Promise(() => {}));
    const view = await render(page(userId));
    expect(enter).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain(stateLabel[state]);
    expect(view.container.querySelector("[data-testid='remote-portal-pick-b']")).not.toBeNull();
    expect(view.container.querySelector("[data-testid='remote-portal-open']")).toBeNull();
    expect(
      view.container.querySelector("[data-testid='remote-portal-remembered-absent']"),
    ).toBeNull();
    expect(view.container.querySelector("[data-testid='account-menu']")).not.toBeNull();
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Thử lại",
    );
    if (!retry) throw new Error("Missing retry");
    if (state === "offline") {
      await act(async () => retry.click());
      expect(list).toHaveBeenCalledTimes(2);
      expect(enter).not.toHaveBeenCalled();
    }
    await view.unmount();
  },
);

it("opens the remembered computer when it is the only one ready", async () => {
  const userId = "user-a";
  localStorage.setItem(preferenceKey(userId), JSON.stringify({ deviceId: "a" }));
  const machine = { ...ready, deviceId: "a", logicalHost: "ha" };
  list.mockResolvedValue({ kind: "open", deviceId: "a", logicalHost: "ha", devices: [machine] });
  enter.mockReturnValue(new Promise(() => {}));
  const view = await render(page(userId));
  expect(enter).toHaveBeenCalledTimes(1);
  expect(enter).toHaveBeenCalledWith({ deviceId: "a" });
  expect(view.container.querySelector("[data-testid='remote-portal-open']")?.textContent).toBe(
    "ha",
  );
  await view.unmount();
});

it("still asks when several computers are ready, including the remembered one", async () => {
  const userId = "user-a";
  localStorage.setItem(preferenceKey(userId), JSON.stringify({ deviceId: "a" }));
  const remembered = { ...ready, deviceId: "a", logicalHost: "ha" };
  const other = { ...ready, deviceId: "c", logicalHost: "hc" };
  list.mockResolvedValue({ kind: "choose", devices: [remembered, other] });
  const view = await render(page(userId));
  expect(enter).not.toHaveBeenCalled();
  expect(view.container.querySelector("[data-testid='remote-portal-pick-a']")).not.toBeNull();
  expect(view.container.querySelector("[data-testid='remote-portal-pick-c']")).not.toBeNull();
  await view.unmount();
});

it("still opens the only ready computer when this account has not chosen one", async () => {
  list.mockResolvedValue({ kind: "open", deviceId: "b", logicalHost: "hb", devices: [ready] });
  enter.mockReturnValue(new Promise(() => {}));
  const view = await render(page("user-a"));
  expect(enter).toHaveBeenCalledWith({ deviceId: "b" });
  expect(localStorage.getItem(preferenceKey("user-b"))).toBeNull();
  await view.unmount();
});

it("says the previous computer is gone only when the list no longer contains it", async () => {
  const userId = "user-a";
  localStorage.setItem(preferenceKey(userId), JSON.stringify({ deviceId: "a" }));
  list.mockResolvedValue({ kind: "open", deviceId: "b", logicalHost: "hb", devices: [ready] });
  enter.mockReturnValue(new Promise(() => {}));
  const view = await render(page(userId));
  expect(enter).not.toHaveBeenCalled();
  expect(
    view.container.querySelector("[data-testid='remote-portal-remembered-absent']")?.textContent,
  ).toBe("Máy đã dùng trước không còn để kết nối.");
  expect(view.container.querySelector("[data-testid='remote-portal-pick-b']")).not.toBeNull();
  expect(view.container.querySelector("[data-testid='account-menu']")).not.toBeNull();
  await view.unmount();
});

it.each([null, "", "   "])(
  "does not replace the remembered computer when opening returns %j",
  async (href) => {
    const assign = stubAssign();
    const userId = "user-a";
    const key = preferenceKey(userId);
    localStorage.setItem(key, JSON.stringify({ deviceId: "a" }));
    const remembered = { ...ready, deviceId: "a", logicalHost: "ha" };
    const other = { ...ready, deviceId: "c", logicalHost: "hc" };
    list.mockResolvedValue({ kind: "choose", devices: [remembered, other] });
    enter.mockResolvedValue({ href });
    const view = await render(page(userId));
    const pick = view.container.querySelector<HTMLButtonElement>(
      "[data-testid='remote-portal-pick-c']",
    );
    if (!pick) throw new Error("Missing computer choice");
    await act(async () => pick.click());
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(JSON.stringify({ deviceId: "a" }));
    expect(view.container.querySelector("[role='alert']")).not.toBeNull();
    await view.unmount();
  },
);

it("remembers only the device id after the chosen computer returns an address", async () => {
  const assign = stubAssign();
  const userId = "user-a";
  const key = preferenceKey(userId);
  localStorage.setItem(key, JSON.stringify({ deviceId: "a" }));
  const remembered = { ...ready, deviceId: "a", logicalHost: "ha" };
  const other = { ...ready, deviceId: "c", logicalHost: "hc" };
  list.mockResolvedValue({ kind: "choose", devices: [remembered, other] });
  enter.mockResolvedValue({ href: "https://host.example/open" });
  const view = await render(page(userId));
  const pick = view.container.querySelector<HTMLButtonElement>(
    "[data-testid='remote-portal-pick-c']",
  );
  if (!pick) throw new Error("Missing computer choice");
  await act(async () => pick.click());
  expect(assign).toHaveBeenCalledWith("/m/c/app");
  expect(JSON.parse(localStorage.getItem(key) ?? "")).toEqual({ deviceId: "c" });
  expect(localStorage.getItem(key)).not.toMatch(/https|ticket|token|@/i);
  await view.unmount();
});

it("keeps the remembered computer when opening fails", async () => {
  const assign = stubAssign();
  const userId = "user-a";
  const key = preferenceKey(userId);
  localStorage.setItem(key, JSON.stringify({ deviceId: "a" }));
  const remembered = { ...ready, deviceId: "a", logicalHost: "ha" };
  const other = { ...ready, deviceId: "c", logicalHost: "hc" };
  list.mockResolvedValue({ kind: "choose", devices: [remembered, other] });
  enter.mockRejectedValue(new TypeError("Network"));
  const view = await render(page(userId));
  const pick = view.container.querySelector<HTMLButtonElement>(
    "[data-testid='remote-portal-pick-c']",
  );
  if (!pick) throw new Error("Missing computer choice");
  await act(async () => pick.click());
  expect(assign).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe(JSON.stringify({ deviceId: "a" }));
  expect(view.container.querySelector("[role='alert']")).not.toBeNull();
  expect(view.container.querySelector("[data-testid='account-menu']")).not.toBeNull();
  await view.unmount();
});

it("keeps working when preference storage is denied and does not read another account", async () => {
  const userId = "user-a";
  const own = preferenceKey(userId);
  const other = preferenceKey("user-b");
  localStorage.setItem(other, JSON.stringify({ deviceId: "stolen" }));
  const original = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
    if (key === own) throw new DOMException("denied");
    return original.call(this, key);
  });
  list.mockResolvedValue({ kind: "open", deviceId: "b", logicalHost: "hb", devices: [ready] });
  enter.mockReturnValue(new Promise(() => {}));
  const view = await render(page(userId));
  expect(enter).toHaveBeenCalledWith({ deviceId: "b" });
  expect(view.container.textContent).not.toContain("stolen");
  expect(view.container.querySelector("[data-testid='account-menu']")).not.toBeNull();
  await view.unmount();
});

it("ignores a broken preference and another account's saved computer", async () => {
  const userId = "user-a";
  localStorage.setItem(preferenceKey(userId), "{");
  localStorage.setItem(preferenceKey("user-b"), JSON.stringify({ deviceId: "stolen" }));
  localStorage.setItem(
    preferenceKey(userId, "https://other.example"),
    JSON.stringify({ deviceId: "a" }),
  );
  list.mockResolvedValue({
    kind: "open",
    deviceId: "b",
    logicalHost: "hb",
    devices: [{ ...ready, deviceId: "a", logicalHost: "ha", state: "offline" }, ready],
  });
  enter.mockReturnValue(new Promise(() => {}));
  const view = await render(page(userId));
  expect(enter).toHaveBeenCalledWith({ deviceId: "b" });
  expect(view.container.textContent).not.toContain("stolen");
  await view.unmount();
});

it("does not follow a stored address when the remembered computer is offline", async () => {
  const assign = stubAssign();
  const userId = "user-a";
  localStorage.setItem(
    preferenceKey(userId),
    JSON.stringify({
      deviceId: "a",
      href: "https://stolen.example/ticket",
      email: "a@example.test",
    }),
  );
  list.mockResolvedValue({
    kind: "open",
    deviceId: "b",
    logicalHost: "hb",
    devices: [{ ...ready, deviceId: "a", logicalHost: "ha", state: "offline" }, ready],
  });
  enter.mockReturnValue(new Promise(() => {}));
  const view = await render(page(userId));
  expect(enter).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("stolen.example");
  expect(view.container.textContent).not.toContain("a@example.test");
  await view.unmount();
});

it("still opens a computer when saving the preference is denied", async () => {
  const assign = stubAssign();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("denied");
  });
  list.mockResolvedValue({ kind: "open", deviceId: "b", logicalHost: "hb", devices: [ready] });
  enter.mockResolvedValue({ href: "https://host.example/open" });
  const view = await render(page("user-a"));
  expect(assign).toHaveBeenCalledWith("/m/b/app");
  expect(view.container.querySelector("[data-testid='account-menu']")).not.toBeNull();
  await view.unmount();
});

it("drops a computer list that finishes after the account changes", async () => {
  let resolveFirst: (portal: unknown) => void = () => {};
  list.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  );
  list.mockResolvedValue({
    kind: "unavailable",
    devices: [{ ...ready, logicalHost: "hb-only", state: "offline" }],
  });
  const view = await render(page("user-a"));
  await view.rerender(page("user-b"));
  await act(async () => {
    resolveFirst({
      kind: "open",
      deviceId: "b",
      logicalHost: "ha-secret",
      devices: [ready],
    });
  });
  expect(enter).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("ha-secret");
  expect(view.container.textContent).toContain("hb-only");
  expect(localStorage.getItem(preferenceKey("user-a"))).toBeNull();
  expect(localStorage.getItem(preferenceKey("user-b"))).toBeNull();
  await view.unmount();
});

it("does not follow or save an enter that finishes after the account changes", async () => {
  const assign = stubAssign();
  const origin = window.location.origin;
  list.mockResolvedValue({
    kind: "choose",
    devices: [ready, { ...ready, deviceId: "c", logicalHost: "hc" }],
  });
  let resolveEnter: (result: { href: string }) => void = () => {};
  enter.mockReturnValue(
    new Promise((resolve) => {
      resolveEnter = resolve;
    }),
  );
  const view = await render(page("user-a"));
  const pick = view.container.querySelector<HTMLButtonElement>(
    "[data-testid='remote-portal-pick-b']",
  );
  if (!pick) throw new Error("Missing computer choice");
  await act(async () => pick.click());
  expect(enter).toHaveBeenCalledTimes(1);
  list.mockResolvedValue({ kind: "unavailable", devices: [] });
  await view.rerender(page("user-b"));
  await act(async () => {
    resolveEnter({ href: "https://host.example/ticket" });
  });
  expect(assign).not.toHaveBeenCalled();
  expect(enter).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(preferenceKey("user-a", origin))).toBeNull();
  expect(localStorage.getItem(preferenceKey("user-b", origin))).toBeNull();
  expect(view.container.querySelector("[data-testid='account-menu']")).not.toBeNull();
  await view.unmount();
});
