import { appContentSecurityPolicy } from "@rakazo/contracts/content-security-policy";
import type * as BrowserModule from "@rakazo/p2p-prototype/browser";
import type { DataPeer } from "@rakazo/p2p-prototype/browser";
import { connectBrowserPeer } from "@rakazo/p2p-prototype/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  activeP2PClient,
  p2pConfig,
  resetP2PClient,
  WebP2PClient,
  webP2PClient,
} from "./p2p-client";

vi.mock("@rakazo/p2p-prototype/browser", async (original) => ({
  ...(await original<typeof BrowserModule>()),
  connectBrowserPeer: vi.fn(),
}));
const sessionSignal = vi.hoisted(() => vi.fn());
vi.mock("./auth", () => ({ authClient: { $store: { notify: sessionSignal } } }));
const config = { gatewayUrl: "http://127.0.0.1:8123", iceServers: [] };
let client: WebP2PClient;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
let sent: string[];
let close: ReturnType<typeof vi.fn<() => void>>;
const turn = {
  urls: ["turn:relay.example.test:3479?transport=udp", "turns:relay.example.test:5350"],
  username: "test-expiry:peer-1",
  credential: "dummy-turn-credential",
  ttl: 60,
};
let turnResponse: () => Promise<Response>;
function peer(denied = false, identity: unknown = { userId: "node-user" }): DataPeer {
  let receive: ((value: IteratorResult<string>) => void) | undefined;
  const queue: string[] = [];
  let ended = false;
  const push = (value: unknown) => {
    const text = JSON.stringify(value);
    if (receive) {
      const wake = receive;
      receive = undefined;
      wake({ value: text, done: false });
    } else queue.push(text);
  };
  close = vi.fn(() => {
    ended = true;
    receive?.({ value: undefined, done: true });
  });
  return {
    open: Promise.resolve(),
    send(text) {
      sent.push(text);
      const frame = JSON.parse(text);
      if (frame.t === "hello")
        push(denied ? { t: "denied" } : { t: "welcome", bearer: "node-bearer" });
      if (frame.t === "call")
        push({
          t: "response",
          bearer: frame.bearer,
          id: frame.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: frame.procedure === "me" ? btoa(JSON.stringify({ json: identity })) : frame.body,
        });
      if (frame.t === "subscribe")
        push({ t: "chunk", bearer: frame.bearer, id: frame.id, data: btoa("data: hello\n\n") });
    },
    messages: {
      [Symbol.asyncIterator]: () => ({
        next() {
          const value = queue.shift();
          if (value) return Promise.resolve({ value, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            receive = resolve;
          });
        },
      }),
    },
    close,
    closeGracefully: async () => {
      close();
    },
    isClosed: () => ended,
    selectedPair: () => null,
    localCandidates: [],
  };
}
beforeEach(() => {
  sessionSignal.mockClear();
  client = new WebP2PClient(config);
  vi.mocked(connectBrowserPeer).mockClear();
  sent = [];
  turnResponse = async () => new Response(null, { status: 501 });
  request = vi.fn(async (input, init) => {
    if (String(input).includes("/turn-credentials?")) return turnResponse();
    if (input === "/api/auth/p2p-token")
      return Response.json({ token: "app-token", expiresAt: Date.now() + 120_000 });
    if (String(input).endsWith("/pair/start"))
      return Response.json({ code: "FAKECODE", expiresAt: Date.now() + 120_000 });
    if (String(input).endsWith("/nodes")) return Response.json({ nodes: [] });
    if (String(input).endsWith("/sessions"))
      return Response.json({
        ...JSON.parse(String(init?.body)),
        assertion: "signed-assertion",
        exp: Date.now() + 60_000,
      });
    throw new Error("unexpected network request");
  });
  vi.stubGlobal("fetch", request);
  vi.mocked(connectBrowserPeer).mockImplementation(async () => peer());
});
it("rechecks the hosted session when an expired account cannot authorize discovery", async () => {
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(client.nodes()).rejects.toThrow("authorization");
  expect(sessionSignal).toHaveBeenCalledWith("$sessionSignal");
  expect(connectBrowserPeer).not.toHaveBeenCalled();
});
afterEach(() => {
  client.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
it("uses a secure configured origin and defaults to STUN only", () => {
  expect(p2pConfig({ VITE_P2P_GATEWAY_URL: config.gatewayUrl })).toEqual({
    gatewayUrl: config.gatewayUrl,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  expect(
    p2pConfig({ VITE_P2P_GATEWAY_URL: config.gatewayUrl, VITE_P2P_ICE_SERVERS: "[]" }),
  ).toEqual(config);
  expect(
    p2pConfig({
      VITE_P2P_GATEWAY_URL: config.gatewayUrl,
      VITE_P2P_ICE_SERVERS: '[{"urls":["stun:example.test:3478"]}]',
    })?.iceServers,
  ).toHaveLength(1);
});
it("uses the configured gateway for both HTTP and WebSocket CSP", () => {
  const config = p2pConfig({ VITE_P2P_GATEWAY_URL: " https://gateway.example.test:8443/ " });
  const policy = appContentSecurityPolicy({ p2pGatewayUrl: config?.gatewayUrl });
  expect(config?.gatewayUrl).toBe("https://gateway.example.test:8443");
  expect(policy).toContain(
    "connect-src 'self' https://gateway.example.test:8443 wss://gateway.example.test:8443;",
  );
  expect(policy).not.toContain("p2p.vnbot.run");
});
it.each([
  "http://example.test",
  "https://user:password@example.test",
  "https://example.test/path",
  "https://example.test?token=x",
])("refuses unsafe gateway %s", (url) => {
  expect(() => p2pConfig({ VITE_P2P_GATEWAY_URL: url })).toThrow();
});
it.each([
  '[{"urls":"turn:fake-user:fake-secret@example.test"}]',
  '{"credential":"fake-secret"}',
  '[{"urls":[]}]',
  "[{}]",
  "fake-secret-not-json",
])("falls back to default STUN and warns without the value for ICE setting %s", (ice) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(p2pConfig({ VITE_P2P_GATEWAY_URL: config.gatewayUrl, VITE_P2P_ICE_SERVERS: ice })).toEqual(
    {
      gatewayUrl: config.gatewayUrl,
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    },
  );
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain("fake-secret");
});
it.each(["", "   "])("uses default STUN silently for blank ICE setting %j", (ice) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(
    p2pConfig({ VITE_P2P_GATEWAY_URL: config.gatewayUrl, VITE_P2P_ICE_SERVERS: ice })?.iceServers,
  ).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
  expect(warn).not.toHaveBeenCalled();
});
it("still creates the shared client when the ICE setting is malformed", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("VITE_P2P_GATEWAY_URL", config.gatewayUrl);
  vi.stubEnv("VITE_P2P_ICE_SERVERS", "not json");
  vi.resetModules();
  const fresh = await import("./p2p-client");
  expect(fresh.webP2PClient()).toBeInstanceOf(fresh.WebP2PClient);
});
it("mints a new scoped token for each pair or node-list action", async () => {
  await client.pair();
  await client.pair();
  await client.nodes();
  const calls = request.mock.calls.filter(([url]) => url === "/api/auth/p2p-token");
  expect(calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { scope: ["pair"] },
    { scope: ["pair"] },
    { scope: ["nodes"] },
  ]);
  expect(
    calls.every(([, init]) => init?.credentials === "include" && init?.cache === "no-store"),
  ).toBe(true);
  expect(
    request.mock.calls.find(([url]) => String(url).endsWith("/pair/start"))?.[1]?.headers,
  ).toMatchObject({ authorization: "Bearer app-token" });
});
it("does not contact the gateway when token minting fails", async () => {
  request.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(client.pair()).rejects.toThrow("authorization");
  expect(request).toHaveBeenCalledTimes(1);
});
it("signals with the scoped assertion and only connects after the authenticated welcome", async () => {
  const listener = vi.fn();
  client.subscribe(listener);
  await client.connect("node-1");
  expect(client.getSnapshot()).toEqual({ state: "connected", nodeId: "node-1" });
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
    scope: ["session"],
    nodeId: "node-1",
  });
  expect(connectBrowserPeer).toHaveBeenCalledWith(
    expect.objectContaining({
      signalUrl: `${config.gatewayUrl}/signal`,
      remoteId: "node-1",
      assertion: "signed-assertion",
      iceServers: [],
    }),
  );
  expect(client.getNodeUserId()).toBe("node-user");
  expect(JSON.parse(sent[0] ?? "")).toEqual({ t: "hello", assertion: "signed-assertion" });
  expect(listener).toHaveBeenCalled();
});
it("does not report connected when the channel cannot identify the authenticated node user", async () => {
  vi.mocked(connectBrowserPeer).mockResolvedValueOnce(peer(false, {}));
  await expect(client.connect("node-1")).rejects.toThrow();
  expect(client.getSnapshot().state).toBe("failed");
  expect(client.getNodeUserId()).toBeUndefined();
});

it("fetches TURN with the session assertion and merges it with configured STUN", async () => {
  const stunConfig = { ...config, iceServers: [{ urls: "stun:stun.example.test:3478" }] };
  client = new WebP2PClient(stunConfig);
  turnResponse = async () => Response.json(turn);
  await client.connect("node-1");
  const call = request.mock.calls.find(([url]) => String(url).includes("/turn-credentials?"));
  expect(call?.[1]).toMatchObject({
    headers: { authorization: "Assertion signed-assertion" },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  expect(new URL(String(call?.[0])).searchParams.get("peer")).toBeTruthy();
  expect(connectBrowserPeer).toHaveBeenCalledWith(
    expect.objectContaining({
      iceServers: [...stunConfig.iceServers, turn],
    }),
  );
});
it.each(["501", "500", "network", "malformed"])(
  "keeps configured STUN on TURN %s",
  async (failure) => {
    const stun = [{ urls: "stun:stun.example.test:3478" }];
    client = new WebP2PClient({ ...config, iceServers: stun });
    turnResponse = async () => {
      if (failure === "network") throw new Error("offline");
      return failure === "malformed"
        ? Response.json({ ...turn, urls: [] })
        : new Response(null, { status: Number(failure) });
    };
    await client.connect("node-1");
    expect(connectBrowserPeer).toHaveBeenCalledWith(expect.objectContaining({ iceServers: stun }));
    expect(client.getSnapshot().state).toBe("connected");
  },
);
it("keeps RPC bytes and subscriptions on the shared channel and propagates cancellation", async () => {
  await client.connect("node-1");
  const response = await client.fetch(
    new Request("https://app.example.test/rpc/bots/list", { method: "POST", body: '{"json":{}}' }),
    new AbortController().signal,
  );
  expect(await response.text()).toBe('{"json":{}}');
  const abort = new AbortController();
  const stream = await client.fetch(
    new Request("https://app.example.test/rpc/threads/subscribe", { method: "POST" }),
    abort.signal,
  );
  expect(stream.headers.get("content-type")).toBe("text/event-stream");
  const reader = stream.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n");
  await reader.cancel();
  expect(sent.map((text) => JSON.parse(text).t)).toContain("cancel");
  client.disconnect();
  await expect(
    client.fetch(new Request("https://app.example.test/rpc/bots/list"), abort.signal),
  ).rejects.toThrow("disconnected");
  expect(client.getSnapshot().nodeId).toBe("node-1");
});
it("denied channel authentication fails and closes the peer", async () => {
  vi.mocked(connectBrowserPeer).mockImplementationOnce(async () => peer(true));
  await expect(client.connect("node-1")).rejects.toThrow("denied");
  expect(client.getSnapshot().state).toBe("failed");
  expect(close).toHaveBeenCalled();
});
it("ignores a stale token response after cancel and permits retry", async () => {
  let resolve!: (res: Response) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const connection = client.connect("old-node");
  client.disconnect();
  await client.connect("new-node");
  resolve(Response.json({ token: "old-token" }));
  await expect(connection).rejects.toThrow();
  expect(client.getSnapshot()).toEqual({ state: "connected", nodeId: "new-node" });
  expect(connectBrowserPeer).toHaveBeenCalledTimes(1);
});
it("reflects remote disconnection and reset removes the remote selection", async () => {
  await client.connect("node-1");
  vi.mocked(connectBrowserPeer).mock.calls[0]?.[0].onClose?.();
  expect(client.getSnapshot()).toEqual({ state: "connecting", nodeId: "node-1" });
  client.reset();
  expect(client.getSnapshot()).toEqual({ state: "disconnected" });
});

it.each([
  ["unset", undefined],
  ["empty", ""],
  ["blank", "   "],
])("creates no client and makes no request when the gateway is %s", (_, url) => {
  vi.stubEnv("VITE_P2P_GATEWAY_URL", url);
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  vi.stubGlobal("window", { location: { pathname: "/app/pairing" } });
  expect(p2pConfig({ VITE_P2P_GATEWAY_URL: url })).toBeUndefined();
  // The ICE setting of a disabled build is never read, so it cannot fail startup either.
  expect(p2pConfig({ VITE_P2P_GATEWAY_URL: url, VITE_P2P_ICE_SERVERS: "invalid" })).toBeUndefined();
  expect(webP2PClient()).toBeUndefined();
  expect(activeP2PClient()).toBeUndefined();
  resetP2PClient();
  expect(request).not.toHaveBeenCalled();
  expect(socket).not.toHaveBeenCalled();
});
it("sends tokens only to the explicitly configured gateway", async () => {
  vi.stubEnv("VITE_P2P_GATEWAY_URL", "https://gateway.example.test");
  vi.resetModules();
  const fresh = await import("./p2p-client");
  await fresh.webP2PClient()?.nodes();
  expect(request.mock.calls.map(([url]) => String(url))).toEqual([
    "/api/auth/p2p-token",
    "https://gateway.example.test/nodes",
  ]);
});
it.each([true, false])(
  "keeps local desktop RPC local while hosted desktop uses P2P (%s)",
  async (local) => {
    vi.stubEnv("VITE_P2P_GATEWAY_URL", "https://gateway.example.test");
    vi.stubGlobal("window", { rakazoDesktop: { p2p: { local } } });
    vi.resetModules();
    const fresh = await import("./p2p-client");
    expect(Boolean(fresh.activeP2PClient())).toBe(!local);
    expect(request).not.toHaveBeenCalled();
  },
);
it("bounds a stalled authorization request and leaves RPC disconnected", async () => {
  vi.useFakeTimers();
  request.mockImplementationOnce(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  const failed = expect(client.connect("node-1")).rejects.toThrow("aborted");
  await vi.advanceTimersByTimeAsync(20_000);
  await failed;
  expect(client.getSnapshot()).toEqual({ state: "failed", nodeId: "node-1" });
  expect(connectBrowserPeer).not.toHaveBeenCalled();
});

it("does not mark a peer connected if it closes during channel setup", async () => {
  vi.mocked(connectBrowserPeer).mockImplementationOnce(async (options) => {
    const connected = peer();
    options.onClose?.();
    return connected;
  });
  await expect(client.connect("node-1")).rejects.toThrow();
  expect(client.getSnapshot()).toEqual({ state: "failed", nodeId: "node-1" });
  expect(close).toHaveBeenCalled();
});
