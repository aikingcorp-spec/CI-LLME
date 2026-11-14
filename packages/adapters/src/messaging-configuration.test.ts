import type { AdapterContext, MessagingInboundEvent } from "@rakazo/adapter-kit";
import type { Pool, PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MessagingConfigurationDenied,
  MessagingConfigurationRejected,
  MessagingConnectionRuntime,
} from "./messaging-configuration.js";
import { EncryptedSecretStore } from "./secrets.js";

const OWNER = "user-owner";
const MEMBER = "user-member";
const TOKEN_A = "111111111:FAKE_TELEGRAM_TOKEN_A";
const TOKEN_B = "222222222:FAKE_TELEGRAM_TOKEN_B";
const BAD_TOKEN = "333333333:FAKE_TELEGRAM_TOKEN_BAD";
const ENV_TOKEN = "444444444:FAKE_TELEGRAM_TOKEN_ENV";
const WEBHOOK_SECRET = "webhook-secret-test";
const ENV_SECRET = "env-webhook-secret";
const SLACK_TOKEN = "xoxb-slack-test";
const SLACK_SIGNING = "slack-signing-test";

const context: AdapterContext = {
  operationId: "op-test",
  traceId: "trace-test",
  spaceId: "space-test",
  userId: OWNER,
  signal: new AbortController().signal,
};

type Behavior = "ok" | "unauthorized" | "offline";

const active = new Set<string>();
const pollOrder: string[] = [];
const fetches: { method: string; token: string }[] = [];
const plaintexts: string[] = [];
const consoleLines: string[] = [];
let behavior: Behavior = "ok";
let holdGetMe = false;
let releaseGetMe: (() => void) | undefined;
let maxActive = 0;
let webhookIssue = 0;
const open: MessagingConnectionRuntime[] = [];
const sink = createTestSink();

function noteActive() {
  maxActive = Math.max(maxActive, active.size);
}

function tokenOf(input: RequestInfo | URL): { token: string; method: string } {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  const match = url.pathname.match(/\/bot([^/]+)\/([^/]+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`unexpected Telegram url ${url.pathname}`);
  return { token: decodeURIComponent(match[1]), method: match[2] };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { token, method } = tokenOf(input);
      fetches.push({ method, token });
      if (behavior === "offline") throw new TypeError("network down");
      if (method === "getMe") {
        if (holdGetMe) {
          await new Promise<void>((resolve) => {
            releaseGetMe = resolve;
          });
        }
        if (behavior === "unauthorized") {
          return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
        }
        return json({ ok: true, result: { id: 999, is_bot: true, username: "testbot" } });
      }
      if (method === "getWebhookInfo") {
        return json({ ok: true, result: { url: "", pending_update_count: 0 } });
      }
      if (method === "deleteWebhook") return json({ ok: true, result: true });
      if (method === "getUpdates") {
        active.add(token);
        pollOrder.push(`start ${token}`);
        noteActive();
        return new Promise((_resolve, reject) => {
          const finish = () => {
            active.delete(token);
            pollOrder.push(`stop ${token}`);
            noteActive();
            reject(new DOMException("aborted", "AbortError"));
          };
          if (init?.signal?.aborted) {
            finish();
            return;
          }
          init?.signal?.addEventListener("abort", finish, { once: true });
        });
      }
      if (method === "sendRichMessage") {
        return json({ ok: false, error_code: 404, description: "Not Found" }, 404);
      }
      if (method === "sendMessage") {
        const payload = JSON.parse(String(init?.body)) as { text: string };
        return json({
          ok: true,
          result: {
            message_id: 42,
            date: 1_700_000_000,
            chat: { id: 123, type: "private" },
            from: { id: 999, is_bot: true, first_name: "Test" },
            text: payload.text,
          },
        });
      }
      return json({ ok: true, result: true });
    }),
  );
}

type FakeClient = {
  listening: boolean;
  destroyed: boolean;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: (destroy?: boolean) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => FakeClient;
  once: (event: string, cb: (...args: unknown[]) => void) => FakeClient;
  removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
};

function createPool() {
  const held = new Map<string, FakeClient>();
  const clients: FakeClient[] = [];
  const pool = {
    held,
    failHeld(connectionId: string) {
      const client = held.get(connectionId);
      if (!client) throw new Error(`no inbound lock for ${connectionId}`);
      client.emit("error", new Error("session lost"));
    },
    async connect() {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const client: FakeClient = {
        listening: false,
        destroyed: false,
        async query(sql, params) {
          if (sql.includes("pg_try_advisory_lock")) {
            const connectionId = String(params?.[1]);
            const owner = held.get(connectionId);
            if (owner && owner !== client) return { rows: [{ acquired: false }] };
            held.set(connectionId, client);
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            const connectionId = String(params?.[1]);
            const released = held.get(connectionId) === client;
            if (released) held.delete(connectionId);
            return { rows: [{ released }] };
          }
          if (sql.startsWith("LISTEN")) {
            client.listening = true;
            return { rows: [] };
          }
          if (sql.startsWith("UNLISTEN")) {
            client.listening = false;
            return { rows: [] };
          }
          if (sql.includes("pg_notify")) {
            const payload = String(params?.[1]);
            for (const other of clients) {
              if (other.listening && !other.destroyed) {
                other.emit("notification", { channel: "messaging_connection", payload });
              }
            }
            return { rows: [] };
          }
          throw new Error(`unexpected sql ${sql}`);
        },
        release(destroy) {
          client.listening = false;
          if (destroy) {
            client.destroyed = true;
            for (const [connectionId, owner] of held) {
              if (owner === client) held.delete(connectionId);
            }
          }
        },
        on(event, cb) {
          const set = listeners.get(event) ?? new Set();
          set.add(cb);
          listeners.set(event, set);
          return client;
        },
        once(event, cb) {
          const wrapped = (...args: unknown[]) => {
            client.removeListener(event, wrapped);
            cb(...args);
          };
          return client.on(event, wrapped);
        },
        removeListener(event, cb) {
          listeners.get(event)?.delete(cb);
        },
        emit(event, ...args) {
          for (const cb of [...(listeners.get(event) ?? [])]) cb(...args);
        },
      };
      clients.push(client);
      return client;
    },
  };
  return pool;
}

function createStore() {
  const rows = new Map<string, { id: string; ciphertext: string }>();
  const spaceFind = vi.fn(async () => ({ id: "space-member", createdByUserId: MEMBER }));
  const membershipFind = vi.fn(async () => [
    { userId: MEMBER, spaceId: "space-member", role: "owner" },
  ]);
  const prisma = {
    integrationProviderConfig: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: { id: string; ciphertext: string };
          update: { ciphertext: string };
        }) => {
          const next = rows.get(where.id)
            ? { id: where.id, ciphertext: update.ciphertext }
            : { id: create.id, ciphertext: create.ciphertext };
          rows.set(where.id, next);
          return next;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const current = rows.get(where.id);
        rows.delete(where.id);
        return current;
      }),
    },
    user: {
      findFirst: vi.fn(async () => ({ id: OWNER })),
    },
    space: { findFirst: spaceFind },
    spaceMember: { findMany: membershipFind },
  } as unknown as PrismaClient;
  const inner = new EncryptedSecretStore("0123456789abcdef0123456789abcdef");
  const secrets = {
    put: async (
      plaintext: string,
      secretContext: AdapterContext,
      options?: { recordId?: string },
    ) => {
      plaintexts.push(plaintext);
      return inner.put(plaintext, secretContext, options);
    },
    load: (ciphertext: string, recordId: string) => inner.load(ciphertext, recordId),
    delete: (ref: string, recordId: string) => inner.delete(ref, recordId),
    onChange: (listener: (ref: string) => void) => inner.onChange(listener),
  };
  return { rows, prisma, secrets, spaceFind, membershipFind };
}

function createRuntime(
  store: ReturnType<typeof createStore>,
  pool: ReturnType<typeof createPool> | undefined,
  baseEnv: ConstructorParameters<typeof MessagingConnectionRuntime>[0]["baseEnv"] = {
    slackBotToken: SLACK_TOKEN,
    slackSigningSecret: SLACK_SIGNING,
  },
  role: "receive" | "send" = "receive",
  schedule?: (delayMs: number, run: () => void) => () => void,
) {
  const runtime = new MessagingConnectionRuntime({
    prisma: store.prisma,
    secrets: store.secrets,
    baseEnv,
    role,
    pool: pool as unknown as Pick<Pool, "connect"> | undefined,
    pollInTests: true,
    schedule,
    createWebhookSecret: () => {
      webhookIssue += 1;
      return webhookIssue === 1 ? WEBHOOK_SECRET : `${WEBHOOK_SECRET}-${webhookIssue}`;
    },
  });
  open.push(runtime);
  return runtime;
}

function leaked(text: string): string[] {
  return [TOKEN_A, TOKEN_B, BAD_TOKEN, ENV_TOKEN, WEBHOOK_SECRET, ENV_SECRET].filter((secret) =>
    text.includes(secret),
  );
}

function observedText(): string {
  return JSON.stringify(sink.events) + consoleLines.join("\n");
}

beforeEach(() => {
  behavior = "ok";
  holdGetMe = false;
  releaseGetMe = undefined;
  maxActive = 0;
  webhookIssue = 0;
  active.clear();
  pollOrder.length = 0;
  fetches.length = 0;
  plaintexts.length = 0;
  consoleLines.length = 0;
  sink.events.length = 0;
  installLogger(createLogger({ service: "messaging-test", level: "debug", sinks: [sink] }));
  installFetch();
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((runtime) => runtime.shutdown()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  installLogger(createLogger({ service: "messaging-test", level: "off", sinks: [] }));
});

it("lets the machine owner save a token and reports ready only after inbound init", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  await runtime.start();
  await runtime.initialize();
  holdGetMe = true;
  const setting = runtime.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(releaseGetMe).toBeTypeOf("function"));
  const starting = await runtime.list(OWNER);
  expect(starting).toMatchObject({
    canManage: true,
    connections: [
      {
        id: "telegram",
        label: "Telegram",
        configured: true,
        state: "starting",
        canConfigure: true,
      },
    ],
  });
  expect(JSON.stringify(starting)).not.toContain(TOKEN_A);
  releaseGetMe?.();
  holdGetMe = false;
  const ready = await setting;
  expect(ready.connections[0]).toMatchObject({ configured: true, state: "ready" });
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  expect(
    plaintexts.some((value) => value.includes(TOKEN_A) && value.includes(WEBHOOK_SECRET)),
  ).toBe(true);
  expect(leaked(observedText())).toEqual([]);
  expect(leaked(JSON.stringify(ready))).toEqual([]);
  for (const row of store.rows.values()) expect(row.ciphertext).not.toContain(TOKEN_A);
});

it("denies a member, including one who owns a personal space", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  await runtime.start();
  await expect(runtime.list(MEMBER)).rejects.toBeInstanceOf(MessagingConfigurationDenied);
  await expect(runtime.set(MEMBER, "telegram", TOKEN_A)).rejects.toBeInstanceOf(
    MessagingConfigurationDenied,
  );
  await expect(runtime.remove(MEMBER, "telegram")).rejects.toBeInstanceOf(
    MessagingConfigurationDenied,
  );
  expect(store.spaceFind).not.toHaveBeenCalled();
  expect(store.membershipFind).not.toHaveBeenCalled();
  expect(store.rows.size).toBe(0);
  expect(leaked(observedText())).toEqual([]);
});

it("does not become ready when the provider rejects or cannot be reached", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  await runtime.start();
  await runtime.initialize();
  behavior = "unauthorized";
  const rejected = await runtime.set(OWNER, "telegram", BAD_TOKEN);
  expect(rejected.connections[0]).toMatchObject({ configured: true, state: "error" });
  expect(active.size).toBe(0);
  expect(leaked(observedText())).toEqual([]);
  expect(leaked(JSON.stringify(rejected))).toEqual([]);

  behavior = "offline";
  const offline = await runtime.set(OWNER, "telegram", BAD_TOKEN);
  expect(offline.connections[0]).toMatchObject({ configured: true, state: "error" });
  expect(active.size).toBe(0);
  expect(runtime.surface.platforms().map((platform) => platform.provider)).toContain("slack");
  expect(runtime.surface.platforms().map((platform) => platform.provider)).not.toContain(
    "telegram",
  );
});

it("stops the previous poll before a replacement and reloads the saved token after restart", async () => {
  const store = createStore();
  const pool = createPool();
  const runtime = createRuntime(store, pool);
  await runtime.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  await runtime.set(OWNER, "telegram", TOKEN_B);
  await vi.waitFor(() => expect(active.has(TOKEN_B)).toBe(true));
  expect(active.has(TOKEN_A)).toBe(false);
  expect(maxActive).toBe(1);
  const stopA = pollOrder.indexOf(`stop ${TOKEN_A}`);
  const startB = pollOrder.indexOf(`start ${TOKEN_B}`);
  expect(stopA).toBeGreaterThanOrEqual(0);
  expect(startB).toBeGreaterThan(stopA);
  await runtime.shutdown();
  const restarted = createRuntime(store, pool);
  await restarted.start();
  await restarted.initialize();
  await vi.waitFor(() => expect(active.has(TOKEN_B)).toBe(true));
  expect(active.has(TOKEN_A)).toBe(false);
});

it("keeps a single inbound consumer across two API processes and never polls from the sender", async () => {
  const store = createStore();
  const pool = createPool();
  const leader = createRuntime(store, pool);
  const follower = createRuntime(store, pool);
  const sender = createRuntime(store, pool, undefined, "send");
  await leader.start();
  await follower.start();
  await sender.start();
  await leader.initialize();
  await follower.initialize();
  await leader.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  expect(maxActive).toBe(1);
  const updatesBeforeSend = fetches.filter((call) => call.method === "getUpdates").length;
  await sender.surface.sendToThread({ threadId: "telegram:123", body: "from the worker" }, context);
  expect(fetches.filter((call) => call.method === "getUpdates")).toHaveLength(updatesBeforeSend);
  expect(fetches.some((call) => call.method === "sendMessage" && call.token === TOKEN_A)).toBe(
    true,
  );
  await follower.set(OWNER, "telegram", TOKEN_B);
  await vi.waitFor(() => expect(active.has(TOKEN_B)).toBe(true));
  expect(active.size).toBe(1);
  expect(maxActive).toBe(1);
  const sent = fetches.filter((call) => call.method === "sendMessage");
  await sender.surface.sendToThread({ threadId: "telegram:123", body: "after replace" }, context);
  const added = fetches.filter((call) => call.method === "sendMessage").slice(sent.length);
  expect(added.map((call) => call.token)).toEqual([TOKEN_B]);
});

it("does not send with a credential that was removed", async () => {
  const store = createStore();
  const pool = createPool();
  const runtime = createRuntime(store, pool);
  const sender = createRuntime(store, pool, undefined, "send");
  await runtime.start();
  await sender.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  await runtime.remove(OWNER, "telegram");
  expect(active.size).toBe(0);
  expect(store.rows.size).toBe(0);
  const before = fetches.length;
  await expect(
    sender.surface.sendToThread({ threadId: "telegram:123", body: "stale" }, context),
  ).rejects.toThrow(/unavailable|No messaging provider/i);
  expect(fetches.slice(before).some((call) => call.token === TOKEN_A)).toBe(false);
  const view = await runtime.list(OWNER);
  expect(view.connections[0]).toMatchObject({ configured: false, state: "unconfigured" });
});

it("sends the replacement credential when a send was waiting on that save", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  await runtime.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  holdGetMe = true;
  const setting = runtime.set(OWNER, "telegram", TOKEN_B);
  await vi.waitFor(() => expect(releaseGetMe).toBeTypeOf("function"));
  const sending = runtime.surface.sendToThread(
    { threadId: "telegram:123", body: "queued" },
    context,
  );
  releaseGetMe?.();
  holdGetMe = false;
  await setting;
  await sending;
  const tokens = fetches.filter((call) => call.method === "sendMessage").map((call) => call.token);
  expect(tokens.at(-1)).toBe(TOKEN_B);
});

it("keeps an env-configured bot out of user removal and still polls that token", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool(), {
    telegramBotToken: ENV_TOKEN,
    telegramWebhookSecret: ENV_SECRET,
    slackBotToken: SLACK_TOKEN,
    slackSigningSecret: SLACK_SIGNING,
  });
  await runtime.start();
  await expect(runtime.set(OWNER, "telegram", TOKEN_A)).rejects.toBeInstanceOf(
    MessagingConfigurationRejected,
  );
  await expect(runtime.remove(OWNER, "telegram")).rejects.toBeInstanceOf(
    MessagingConfigurationRejected,
  );
  expect(store.rows.size).toBe(0);
  await runtime.initialize();
  await vi.waitFor(() => expect(active.has(ENV_TOKEN)).toBe(true));
  const view = await runtime.list(OWNER);
  expect(view.connections[0]).toMatchObject({
    configured: true,
    canConfigure: false,
    state: "ready",
  });
  expect(leaked(JSON.stringify(view))).toEqual([]);
  expect(runtime.surface.platforms().map((platform) => platform.provider)).toEqual(
    expect.arrayContaining(["telegram", "slack"]),
  );
});

it("drops the inbound poll when the lock session dies and does not run two polls", async () => {
  const store = createStore();
  const pool = createPool();
  const runtime = createRuntime(store, pool);
  await runtime.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  pool.failHeld("telegram");
  await vi.waitFor(() => expect(pollOrder.includes(`stop ${TOKEN_A}`)).toBe(true));
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  expect(maxActive).toBe(1);
});

it("delivers a signed webhook to the sink registered before the token was saved", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  const inbound: MessagingInboundEvent[] = [];
  runtime.surface.onInbound(async (event) => {
    inbound.push(event);
  });
  await runtime.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  const update = {
    update_id: 7,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: 123, type: "private", first_name: "Ada" },
      from: { id: 123, is_bot: false, first_name: "Ada" },
      text: "hello from telegram",
    },
  };
  const request = (secret?: string) =>
    new Request("https://example.test/api/messaging/webhook/telegram", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      },
      body: JSON.stringify(update),
    });
  expect((await runtime.surface.handleWebhook("telegram", request()))?.status).toBe(401);
  expect((await runtime.surface.handleWebhook("telegram", request("wrong-secret")))?.status).toBe(
    401,
  );
  expect(inbound).toEqual([]);
  expect((await runtime.surface.handleWebhook("telegram", request(WEBHOOK_SECRET)))?.status).toBe(
    200,
  );
  expect(inbound[0]).toMatchObject({
    provider: "telegram",
    from: "123",
    threadId: "telegram:123",
    type: "message",
  });
});

it("takes over inbound polling after the other API shuts down without another settings write", async () => {
  const store = createStore();
  const pool = createPool();
  const leader = createRuntime(store, pool);
  const follower = createRuntime(store, pool);
  await leader.start();
  await leader.initialize();
  await leader.set(OWNER, "telegram", TOKEN_A);
  await follower.start();
  await follower.initialize();
  expect(active.has(TOKEN_A)).toBe(true);
  await leader.shutdown();
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true), { timeout: 2000 });
  expect(maxActive).toBe(1);
});

it("starts an existing named Telegram bot when no default token was configured", async () => {
  const runtime = createRuntime(createStore(), createPool(), {
    telegramBots: [{ name: "sales", botToken: TOKEN_A, webhookSecret: WEBHOOK_SECRET }],
  });
  await runtime.start();
  await runtime.initialize();
  expect(
    runtime.surface.platforms().some((platform) => platform.provider === "telegram-sales"),
  ).toBe(true);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true), { timeout: 2000 });
});

it("reports an unreadable saved credential as an error rather than unconfigured", async () => {
  const store = createStore();
  const initial = createRuntime(store, createPool());
  await initial.start();
  await initial.initialize();
  await initial.set(OWNER, "telegram", TOKEN_A);
  await initial.shutdown();
  store.secrets.load = async () => {
    throw new Error("Credential store unavailable");
  };
  const restarted = createRuntime(store, createPool());
  await restarted.start();
  await restarted.initialize().catch(() => undefined);
  expect((await restarted.list(OWNER)).connections[0]).toMatchObject({
    configured: true,
    state: "error",
  });
});

it("stops inbound use after removal even when secret cleanup fails", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  await runtime.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  expect(active.has(TOKEN_A)).toBe(true);
  store.secrets.delete = async () => {
    throw new Error("Secret cleanup unavailable");
  };
  await runtime.remove(OWNER, "telegram").catch(() => undefined);
  expect(store.rows.size).toBe(0);
  expect(active.has(TOKEN_A)).toBe(false);
});

it("keeps a named Telegram bot and Slack up when the managed token changes", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool(), {
    slackBotToken: SLACK_TOKEN,
    slackSigningSecret: SLACK_SIGNING,
    telegramBots: [{ name: "sales", botToken: TOKEN_A, webhookSecret: WEBHOOK_SECRET }],
  });
  await runtime.start();
  await runtime.initialize();
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  expect(runtime.surface.platforms().map((platform) => platform.provider)).toEqual(
    expect.arrayContaining(["slack", "telegram-sales"]),
  );
  await runtime.set(OWNER, "telegram", TOKEN_B);
  await vi.waitFor(() => expect(active.has(TOKEN_B)).toBe(true));
  expect(active.has(TOKEN_A)).toBe(true);
  expect(pollOrder.filter((line) => line === `start ${TOKEN_A}`)).toEqual([`start ${TOKEN_A}`]);
  expect(pollOrder.filter((line) => line === `stop ${TOKEN_A}`)).toEqual([]);
  await runtime.remove(OWNER, "telegram");
  expect(active.has(TOKEN_B)).toBe(false);
  expect(active.has(TOKEN_A)).toBe(true);
  expect(runtime.surface.platforms().map((platform) => platform.provider)).not.toContain(
    "telegram",
  );
});

it("takes over on an injected clock without a settings write and does not poll twice", async () => {
  const pending: Array<{ delay: number; live: boolean; ran: boolean; run: () => void }> = [];
  const schedule = (delay: number, run: () => void) => {
    const entry = {
      delay,
      live: true,
      ran: false,
      run: () => {
        entry.ran = true;
        run();
      },
    };
    pending.push(entry);
    return () => {
      entry.live = false;
    };
  };
  const outstanding = () => pending.filter((entry) => entry.live && !entry.ran);
  const store = createStore();
  const pool = createPool();
  const leader = createRuntime(store, pool, undefined, "receive", schedule);
  const follower = createRuntime(store, pool, undefined, "receive", schedule);
  await leader.start();
  await leader.initialize();
  await leader.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  await follower.start();
  await follower.initialize();
  expect(outstanding()).toHaveLength(1);
  expect(outstanding()[0]?.delay).toBeGreaterThan(0);
  expect(outstanding()[0]?.delay).toBeLessThanOrEqual(1000);
  outstanding()[0]?.run();
  await vi.waitFor(() => expect(outstanding()).toHaveLength(1));
  expect(pollOrder.filter((line) => line === `start ${TOKEN_A}`)).toEqual([`start ${TOKEN_A}`]);
  expect(maxActive).toBe(1);
  await leader.shutdown();
  outstanding()[0]?.run();
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  expect(pollOrder.filter((line) => line === `start ${TOKEN_A}`)).toEqual([
    `start ${TOKEN_A}`,
    `start ${TOKEN_A}`,
  ]);
  expect(maxActive).toBe(1);
  expect(outstanding()).toHaveLength(0);
});

it("does not poll after a waiting process shuts down", async () => {
  const pending: Array<{ live: boolean; run: () => void }> = [];
  const schedule = (_delay: number, run: () => void) => {
    const entry = { live: true, run };
    pending.push(entry);
    return () => {
      entry.live = false;
    };
  };
  const store = createStore();
  const pool = createPool();
  const leader = createRuntime(store, pool, undefined, "receive", schedule);
  const follower = createRuntime(store, pool, undefined, "receive", schedule);
  await leader.start();
  await leader.initialize();
  await leader.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  await follower.start();
  await follower.initialize();
  expect(pending.filter((entry) => entry.live)).toHaveLength(1);
  await follower.shutdown();
  expect(pending.filter((entry) => entry.live)).toHaveLength(0);
  const starts = pollOrder.filter((line) => line === `start ${TOKEN_A}`).length;
  pending[0]?.run();
  expect(pollOrder.filter((line) => line === `start ${TOKEN_A}`)).toHaveLength(starts);
  expect(active.size).toBe(1);
});

it("stops a live poll when the saved credential can no longer be read", async () => {
  const store = createStore();
  const runtime = createRuntime(store, createPool());
  await runtime.start();
  await runtime.initialize();
  await runtime.set(OWNER, "telegram", TOKEN_A);
  await vi.waitFor(() => expect(active.has(TOKEN_A)).toBe(true));
  store.secrets.load = async () => {
    throw new Error("Credential store unavailable");
  };
  const view = await runtime.set(OWNER, "telegram", TOKEN_B);
  expect(active.has(TOKEN_A)).toBe(false);
  expect(active.has(TOKEN_B)).toBe(false);
  expect(view.connections[0]).toMatchObject({ configured: true, state: "error" });
  expect(leaked(JSON.stringify(view))).toEqual([]);
  expect(leaked(observedText())).toEqual([]);
});
