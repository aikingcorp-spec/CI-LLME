import type { InferRouterInitialContext } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { EncryptedSecretStore, MessagingConnectionRuntime } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const OWNER = "user-owner";
const MEMBER = "user-member";
const TOKEN = "111111111:FAKE_TELEGRAM_TOKEN_A";
const BAD_TOKEN = "333333333:FAKE_TELEGRAM_TOKEN_BAD";
const WEBHOOK_SECRET = "webhook-secret-test";

const sink = createTestSink();
const open: MessagingConnectionRuntime[] = [];

function actor(userId: string): Actor {
  return {
    spaceId: "space-1",
    userId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  };
}

function installFetch(behavior: "ok" | "unauthorized" = "ok") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = new URL(raw).pathname.split("/").at(-1);
      if (behavior === "unauthorized" && method === "getMe") {
        return Response.json(
          { ok: false, error_code: 401, description: "Unauthorized" },
          { status: 401 },
        );
      }
      if (method === "getMe") {
        return Response.json({ ok: true, result: { id: 999, is_bot: true, username: "testbot" } });
      }
      if (method === "getWebhookInfo") {
        return Response.json({ ok: true, result: { url: "", pending_update_count: 0 } });
      }
      if (method === "deleteWebhook") return Response.json({ ok: true, result: true });
      if (method === "getUpdates") {
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      return Response.json({ ok: true, result: true });
    }),
  );
}

function createRuntime(behavior: "ok" | "unauthorized" = "ok") {
  installFetch(behavior);
  const rows = new Map<string, { id: string; ciphertext: string }>();
  const spaceFind = vi.fn(async () => ({ id: "space-member", createdByUserId: MEMBER }));
  const prisma = {
    integrationProviderConfig: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { id: string; ciphertext: string };
        update: { ciphertext: string };
      }) => {
        const next = { id: where.id, ciphertext: update.ciphertext ?? create.ciphertext };
        rows.set(where.id, next);
        return next;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
      },
    },
    user: { findFirst: async () => ({ id: OWNER }) },
    space: { findFirst: spaceFind },
    spaceMember: { findMany: async () => [{ userId: MEMBER, spaceId: "space-member" }] },
  } as unknown as PrismaClient;
  const secrets = new EncryptedSecretStore("0123456789abcdef0123456789abcdef");
  const runtime = new MessagingConnectionRuntime({
    prisma,
    secrets,
    baseEnv: {},
    role: "receive",
    pollInTests: true,
    createWebhookSecret: () => WEBHOOK_SECRET,
  });
  open.push(runtime);
  const deps = {
    prisma,
    jobs: { enqueue: vi.fn(async () => undefined) },
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
    messagingConfiguration: runtime,
  } as unknown as RouterDeps;
  return {
    runtime,
    spaceFind,
    handler: new RPCHandler(createRouter(deps)),
  };
}

async function call(
  handler: RPCHandler<InferRouterInitialContext<ReturnType<typeof createRouter>>>,
  userId: string,
  path: string,
  body: unknown = {},
) {
  const { response } = await handler.handle(
    new Request(`http://127.0.0.1/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: body }),
    }),
    { prefix: "/rpc", context: { actor: actor(userId) } },
  );
  if (!response) throw new Error("no response");
  const text = await response.text();
  return { status: response.status, text };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((runtime) => runtime.shutdown()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  installLogger(createLogger({ service: "messaging-test", level: "off", sinks: [] }));
});

it("returns the saved connection to the machine owner without the token", async () => {
  installLogger(createLogger({ service: "messaging-test", level: "debug", sinks: [sink] }));
  sink.events.length = 0;
  const { runtime, handler } = createRuntime();
  await runtime.start();
  await runtime.initialize();
  const response = await call(handler, OWNER, "messaging/configuration/set", {
    connectionId: "telegram",
    credential: TOKEN,
  });
  expect(response.status).toBe(200);
  expect(response.text).not.toContain(TOKEN);
  expect(response.text).not.toContain(WEBHOOK_SECRET);
  expect(response.text).toContain("ready");
  expect(JSON.stringify(sink.events)).not.toContain(TOKEN);
  const listed = await call(handler, OWNER, "messaging/configuration/list");
  expect(listed.status).toBe(200);
  expect(listed.text).toContain('"canManage":true');
  expect(listed.text).not.toContain(TOKEN);
});

it("denies a member and a member who owns a personal space", async () => {
  const { runtime, handler, spaceFind } = createRuntime();
  await runtime.start();
  const member = await call(handler, MEMBER, "messaging/configuration/set", {
    connectionId: "telegram",
    credential: TOKEN,
  });
  expect(member.status).toBe(403);
  expect(member.text).not.toContain(TOKEN);
  expect(spaceFind).not.toHaveBeenCalled();
  const ownerSpace = await call(handler, MEMBER, "messaging/configuration/list");
  expect(ownerSpace.status).toBe(403);
  expect(ownerSpace.text).not.toContain(TOKEN);
});

it("reports an invalid token as not ready and does not echo it", async () => {
  installLogger(createLogger({ service: "messaging-test", level: "debug", sinks: [sink] }));
  sink.events.length = 0;
  const { runtime, handler } = createRuntime("unauthorized");
  await runtime.start();
  await runtime.initialize();
  const response = await call(handler, OWNER, "messaging/configuration/set", {
    connectionId: "telegram",
    credential: BAD_TOKEN,
  });
  expect(response.status).toBe(200);
  expect(response.text).toContain("error");
  expect(response.text).not.toContain("ready");
  expect(response.text).not.toContain(BAD_TOKEN);
  expect(JSON.stringify(sink.events)).not.toContain(BAD_TOKEN);
});
