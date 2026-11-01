// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { P2PSnapshot, WebP2PClient } from "../lib/p2p-client";
import { queryClient } from "../lib/query";
import { clearSpaceSelection } from "../lib/rpc";
import { PairingPage } from "./Pairing";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/LanguageSwitch", () => ({ LanguageSwitch: () => null }));
vi.mock("../components/ai/primitives", () => ({
  LoadingState: ({ label }: { label: string }) => <p>{label}</p>,
}));
vi.mock("../lib/query", () => ({ queryClient: { clear: vi.fn() } }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let snapshot: P2PSnapshot;
let listeners: Set<() => void>;
let client: Pick<
  WebP2PClient,
  "getSnapshot" | "subscribe" | "nodes" | "pair" | "connect" | "disconnect"
>;
const node = {
  nodeId: "fake-desktop",
  name: "Test computer",
  kind: "linux" as const,
  online: true,
  pairedAt: 0,
  lastSeenAt: null,
};
function state(next: P2PSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  snapshot = { state: "disconnected" };
  listeners = new Set();
  client = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    nodes: vi.fn(async () => [
      node,
      { ...node, nodeId: "offline", name: "Offline computer", online: false },
    ]),
    pair: vi.fn(async () => ({ code: "FAKECODE", expiresAt: Date.now() + 120_000 })),
    connect: vi.fn(async (nodeId) => {
      state({ state: "connected", nodeId });
    }),
    disconnect: vi.fn(() => state({ state: "disconnected", nodeId: snapshot.nodeId })),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function render() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PairingPage client={client} />
      </MemoryRouter>,
    ),
  );
}
it("lists paired nodes, disables offline nodes, and reveals the pairing code only on request", async () => {
  await render();
  expect(host.textContent).toContain("Test computer");
  expect(host.textContent).toContain("Offline");
  expect(host.querySelector("output")).toBeNull();
  const offline = host.querySelectorAll("li")[1]?.querySelector("button");
  expect(offline?.disabled).toBe(true);
  await click("Get pairing code");
  expect(host.querySelector('output[aria-label="Pairing code"]')?.textContent).toBe("FAKECODE");
  expect(host.textContent).toContain("two minutes");
});
it("connects, clears the hosted query cache and space, and offers navigation and disconnect", async () => {
  await render();
  await click("Connect");
  expect(client.connect).toHaveBeenCalledWith("fake-desktop");
  expect(clearSpaceSelection).toHaveBeenCalledOnce();
  expect(queryClient.clear).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Connected");
  expect(
    Array.from(host.querySelectorAll("a"))
      .find((a) => a.textContent === "Open computer")
      ?.getAttribute("href"),
  ).toBe("/app");
  await click("Disconnect");
  expect(host.textContent).toContain("Disconnected");
});
it("offers cancellation and renders remote failure without raw errors", async () => {
  vi.mocked(client.connect).mockImplementationOnce(async (nodeId) => {
    state({ state: "connecting", nodeId });
  });
  await render();
  await click("Connect");
  expect(host.textContent).toContain("Connecting…");
  await click("Cancel");
  expect(client.disconnect).toHaveBeenCalledOnce();
  await act(async () => state({ state: "failed", nodeId: node.nodeId }));
  expect(host.textContent).toContain("Could not connect. Try another network.");
});
it("shows a concise error and allows refresh after a list failure", async () => {
  vi.mocked(client.nodes).mockRejectedValueOnce(new Error("private endpoint details"));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not load pairing information",
  );
  expect(host.textContent).not.toContain("private endpoint");
  await click("Refresh");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("shows pairing failures and retries", async () => {
  vi.mocked(client.pair).mockRejectedValueOnce(new Error("internal token"));
  await render();
  await click("Get pairing code");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await click("Get pairing code");
  expect(host.querySelector("output")).not.toBeNull();
});
it("expires codes and stops polling on unmount", async () => {
  vi.useFakeTimers();
  await render();
  await click("Get pairing code");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(host.querySelector("output")).toBeNull();
  expect(
    Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Get pairing code",
    )?.disabled,
  ).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("polls for a completed pairing and hides its consumed code", async () => {
  vi.useFakeTimers();
  await render();
  await click("Get pairing code");
  vi.mocked(client.nodes).mockResolvedValue([
    node,
    { ...node, nodeId: "new-desktop", name: "New computer" },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(host.textContent).toContain("New computer");
  expect(host.querySelector("output")).toBeNull();
});
it.each([
  ["unset", undefined],
  ["empty", ""],
  ["blank", "   "],
])("shows a configuration error and opens no connection when the gateway is %s", async (_, url) => {
  vi.stubEnv("VITE_P2P_GATEWAY_URL", url);
  const request = vi.fn<typeof fetch>();
  const socket = vi.fn();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("WebSocket", socket);
  vi.stubGlobal("RTCPeerConnection", socket);
  vi.useFakeTimers();
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PairingPage />
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "P2P gateway is not configured for this web build.",
  );
  expect(host.querySelector("h1")?.textContent).toBe("Pair a computer");
  expect(host.querySelector("button")).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(socket).not.toHaveBeenCalled();
});
