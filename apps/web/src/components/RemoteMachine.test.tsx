// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { QueryUserProvider } from "../lib/query";
import { RemoteMachinePage } from "./RemoteMachine";

const { enter, signOut } = vi.hoisted(() => ({ enter: vi.fn(), signOut: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { remoteHosts: { enter } } }));
vi.mock("../lib/sign-out", () => ({ signOut }));
vi.mock("./PageAccountMenu", () => ({
  PageAccountMenu: () => <button type="button">Account</button>,
}));
vi.mock("./PageLoading", () => ({ PageLoading: () => <p>Loading</p> }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
afterEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

function Location() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}
async function mount(userId = "fake-user") {
  window.history.replaceState(null, "", "/m/fake-device/app#invite=fake-invite");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (user: string) =>
    act(async () =>
      root.render(
        <QueryUserProvider value={user}>
          <MemoryRouter initialEntries={["/m/fake-device/app"]}>
            <Location />
            <Routes>
              <Route path="/m/:deviceId/*" element={<RemoteMachinePage />} />
            </Routes>
          </MemoryRouter>
        </QueryUserProvider>,
      ),
    );
  await render(userId);
  return {
    container,
    render,
    stop: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("keeps the host inside a cross-origin sandbox and carries the pending invitation", async () => {
  enter.mockResolvedValue({ href: "https://computer.example.test/remote-enter#fake-ticket" });
  const view = await mount();
  try {
    const frame = view.container.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    expect(frame.title).toBe("VNBot");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame.getAttribute("allow")).toContain("microphone");
    const values = new URLSearchParams(new URL(frame.src).hash.slice(1));
    expect(values.get("invite")).toBe("fake-invite");
    expect(values.get("next")).toBe("/app");
    expect(window.location.pathname).toBe("/m/fake-device/app");
    expect(window.location.hash).toBe("");
    const message = { type: "vnbot.remote.navigation", path: "/app/fake-bot" };
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://other.example.test",
          source: frame.contentWindow,
          data: message,
        }),
      ),
    );
    expect(view.container.querySelector("output")?.textContent).toBe("/m/fake-device/app");
    await act(async () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://computer.example.test",
          source: frame.contentWindow,
          data: message,
        }),
      ),
    );
    expect(view.container.querySelector("output")?.textContent).toBe("/m/fake-device/app/fake-bot");
    expect(enter).toHaveBeenCalledTimes(1);
  } finally {
    await view.stop();
  }
});

it("keeps account and retry exits when the computer is unavailable", async () => {
  enter.mockResolvedValue({ href: null });
  const view = await mount();
  try {
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).toContain("Account");
    expect(view.container.textContent).toContain("Thử lại");
  } finally {
    await view.stop();
  }
});

it("never displays a response that belongs to the previous signed-in account", async () => {
  let old: (value: { href: string }) => void = () => {};
  enter
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockImplementationOnce(() => new Promise(() => {}));
  const view = await mount("fake-user-a");
  try {
    await view.render("fake-user-b");
    await act(async () => old({ href: "https://computer.example.test/remote-enter#old-ticket" }));
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(enter).toHaveBeenCalledTimes(2);
  } finally {
    await view.stop();
  }
});
