import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { completeMcpOauth, connectMcpOauth } from "./mcp-connect";

const f = vi.hoisted(() => ({
  begin: vi.fn(),
  complete: vi.fn(),
  session: vi.fn(),
  client: vi.fn(),
}));
vi.mock("./rpc", () => ({ rpc: { mcp: { oauth: { begin: f.begin, complete: f.complete } } } }));
vi.mock("./auth", () => ({ authClient: { getSession: f.session } }));
vi.mock("./p2p-client", () => ({ webP2PClient: f.client }));
let values: Map<string, string>;
let popup: {
  close: ReturnType<typeof vi.fn>;
  location: { replace: ReturnType<typeof vi.fn> };
  closed: boolean;
};
let channel: { onmessage?: (event: { data: unknown }) => void; close: ReturnType<typeof vi.fn> };
let open: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  values = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  popup = { close: vi.fn(), location: { replace: vi.fn() }, closed: false };
  open = vi.fn(() => popup);
  vi.stubGlobal("window", {
    open,
    location: { origin: "https://app.example.test", assign: vi.fn() },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      close = vi.fn();
      constructor() {
        channel = this;
      }
    },
  );
  f.session.mockResolvedValue({ data: { user: { id: "owner" } } });
  f.begin.mockResolvedValue({
    status: "authorization_required",
    sessionId: "attempt",
    authorizationUrl: "https://provider.example.test/auth",
  });
  f.complete.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reserves the popup before network work and ignores another attempt's completion", async () => {
  const pending = connectMcpOauth("server");
  expect(open).toHaveBeenCalledWith("about:blank", expect.any(String), expect.any(String));
  await vi.advanceTimersByTimeAsync(0);
  expect(popup.location.replace).toHaveBeenCalledWith("https://provider.example.test/auth");
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  channel.onmessage?.({ data: { type: "mcp-oauth-complete", state: "other" } });
  await Promise.resolve();
  expect(settled).toBe(false);
  channel.onmessage?.({ data: { type: "mcp-oauth-complete", state: "attempt" } });
  expect(await pending).toBe("connected");
  expect(channel.close).toHaveBeenCalled();
});

it("closes its blank popup when authorization cannot start", async () => {
  f.begin.mockRejectedValue(new Error("unavailable"));
  await expect(connectMcpOauth("server")).rejects.toThrow("unavailable");
  expect(popup.close).toHaveBeenCalledOnce();
});

function route(userId = "owner", expires = Date.now() + 60_000) {
  values.set("vnbot:mcp-oauth:attempt", JSON.stringify({ nodeId: "node-a", userId, expires }));
}

it("restores the originating node before completing OAuth in a fresh tab", async () => {
  route();
  let connected = false;
  const connect = vi.fn(async () => {
    connected = true;
  });
  f.client.mockReturnValue({
    connect,
    getSnapshot: () => ({
      nodeId: connected ? "node-a" : undefined,
      state: connected ? "connected" : "disconnected",
    }),
  });
  await completeMcpOauth("attempt", "private-code");
  expect(connect).toHaveBeenCalledWith("node-a");
  expect(f.complete).toHaveBeenCalledWith({
    sessionId: "attempt",
    code: "private-code",
    state: "attempt",
  });
  expect(values.size).toBe(0);
});

it.each(["missing", "expired", "other-user"])(
  "refuses %s routing without falling back to hosted RPC",
  async (kind) => {
    if (kind !== "missing")
      route(
        kind === "other-user" ? "someone-else" : "owner",
        kind === "expired" ? Date.now() - 1 : Date.now() + 60_000,
      );
    f.client.mockReturnValue({ getSnapshot: () => ({ state: "disconnected" }) });
    await expect(completeMcpOauth("attempt", "private-code")).rejects.toThrow("missing or expired");
    expect(f.complete).not.toHaveBeenCalled();
  },
);

it("keeps routing for retry when its node cannot reconnect", async () => {
  route();
  f.client.mockReturnValue({
    connect: vi.fn().mockRejectedValue(new Error("offline")),
    getSnapshot: () => ({ state: "disconnected" }),
  });
  await expect(completeMcpOauth("attempt", "private-code")).rejects.toThrow("offline");
  expect(f.complete).not.toHaveBeenCalled();
  expect(values.size).toBe(1);
});
