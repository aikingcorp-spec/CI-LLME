import { createHash } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { PlanLimitReading, PlanLimits, PlanLimitWindow } from "@rakazo/contracts";
import { cancelResponseBody, readBoundedJsonResponse } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { parseModelSecret } from "./model-secret.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  CHATGPT_OAUTH_PROVIDER,
  oauthCredentialAccountId,
} from "./pi-oauth.js";

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const FRESH_MS = 60_000;
const FAILURE_RETRY_MS = 15_000;
const STALE_MS = 30 * 60_000;
const MAX_ENTRIES = 512;

class PlanLimitHttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }
}

type Reader = {
  /** What people call the subscription. Returned as display data, not a schema field. */
  name: string;
  read: (credential: OAuthCredential, fetchImpl: typeof fetch) => Promise<PlanLimitWindow[]>;
};

export type PlanLimitReadRequest = {
  userId: string;
  credentialId: string;
  secretId: string;
  provider: string;
  credential: OAuthCredential | null;
  signal?: AbortSignal;
};

type Entry = {
  windows: PlanLimitWindow[];
  checkedAt: number | null;
  freshUntil: number;
  retryAt: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schema");
  return value as Record<string, unknown>;
}

function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("schema");
  return Math.min(100, Math.max(0, value));
}

/** Seconds since the epoch or an ISO string. Anything else is an unknown reset. */
function resetTime(value: unknown): string | null {
  const ms =
    typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function periodFor(seconds: unknown): PlanLimitWindow["period"] | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  if (seconds <= 86_400) return "session";
  if (seconds <= 8 * 86_400) return "week";
  return "month";
}

function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const timeout = abortAfter(TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { ...headers, accept: "application/json" },
      redirect: "error",
      signal: timeout.signal,
    });
    if (!response.ok) {
      cancelResponseBody(response);
      throw new PlanLimitHttpError(response.status);
    }
    return await readBoundedJsonResponse(response, MAX_BYTES, timeout.signal);
  } finally {
    timeout.cancel();
  }
}

/** Shared session and weekly windows. A per-model window is not the shared allowance. */
export function parseClaudePlanLimits(payload: unknown): PlanLimitWindow[] {
  const body = record(payload);
  const windows: PlanLimitWindow[] = [];
  for (const [key, period] of [
    ["five_hour", "session"],
    ["seven_day", "week"],
  ] as const) {
    if (body[key] == null) continue;
    const window = record(body[key]);
    windows.push({
      period,
      usedPercent: percent(window.utilization),
      resetsAt: resetTime(window.resets_at),
    });
  }
  return windows;
}

/** Primary and secondary windows, named by their length. */
export function parseChatGptPlanLimits(payload: unknown): PlanLimitWindow[] {
  const limits = record(record(payload).rate_limit);
  const windows: PlanLimitWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    if (limits[key] == null) continue;
    const window = record(limits[key]);
    const period = periodFor(window.limit_window_seconds);
    if (!period) continue;
    windows.push({
      period,
      usedPercent: percent(window.used_percent),
      resetsAt: resetTime(window.reset_at),
    });
  }
  return windows;
}

const READERS: Record<string, Reader> = {
  [ANTHROPIC_OAUTH_PROVIDER]: {
    name: "Claude",
    read: async (credential, fetchImpl) =>
      parseClaudePlanLimits(
        await getJson(fetchImpl, "https://api.anthropic.com/api/oauth/usage", {
          authorization: `Bearer ${credential.access}`,
          "anthropic-beta": "oauth-2025-04-20",
        }),
      ),
  },
  [CHATGPT_OAUTH_PROVIDER]: {
    name: "ChatGPT",
    read: async (credential, fetchImpl) => {
      const accountId = oauthCredentialAccountId(credential);
      if (!accountId) throw new Error("account");
      return parseChatGptPlanLimits(
        await getJson(fetchImpl, "https://chatgpt.com/backend-api/wham/usage", {
          authorization: `Bearer ${credential.access}`,
          "chatgpt-account-id": accountId,
          originator: "vnbot",
        }),
      );
    },
  },
};

export const PLAN_LIMIT_PROVIDERS = Object.keys(READERS);

function authIdentity(credential: OAuthCredential): string {
  return (
    oauthCredentialAccountId(credential) ??
    createHash("sha256").update(credential.access).digest("hex")
  );
}

/**
 * User, credential, secret, and OAuth account stay in the key so a replaced or
 * revoked sign-in cannot reuse the previous account's reading.
 */
function cacheKey(input: PlanLimitReadRequest, identity: string): string {
  return [input.userId, input.credentialId, input.provider, input.secretId, identity].join("\n");
}

function checkedAtIso(ms: number): string {
  return new Date(ms).toISOString();
}

export class PlanLimitsReader {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<PlanLimitReading | null>>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null when this connection has no allowance to show. Unavailable is a real reading. */
  async read(input: PlanLimitReadRequest): Promise<PlanLimitReading | null> {
    if (!READERS[input.provider]) return null;
    if (!input.credential) return { status: "unavailable" };
    const key = cacheKey(input, authIdentity(input.credential));
    const now = this.now();
    if (input.signal?.aborted) return this.present(key, now);
    const cached = this.cache.get(key);
    if (cached && cached.retryAt > now) return this.present(key, now);
    if (input.credential.expires <= now) return this.present(key, now);
    const existing = this.pending.get(key);
    const task = existing ?? this.start(key, input);
    return this.untilAbort(task, input.signal, () => this.present(key, this.now()));
  }

  private start(key: string, input: PlanLimitReadRequest): Promise<PlanLimitReading | null> {
    const task = this.fetchAndStore(key, input).finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  private async fetchAndStore(
    key: string,
    input: PlanLimitReadRequest,
  ): Promise<PlanLimitReading | null> {
    const reader = READERS[input.provider];
    const credential = input.credential;
    if (!reader || !credential) return { status: "unavailable" };
    try {
      const windows = await reader.read(credential, this.fetchImpl);
      const at = this.now();
      if (!windows.length) {
        this.store(key, {
          windows: [],
          checkedAt: at,
          freshUntil: at + FRESH_MS,
          retryAt: at + FRESH_MS,
        });
        return null;
      }
      this.store(key, {
        windows,
        checkedAt: at,
        freshUntil: at + FRESH_MS,
        retryAt: at + FRESH_MS,
      });
      return { status: "fresh", checkedAt: checkedAtIso(at), windows };
    } catch (error) {
      if (error instanceof PlanLimitHttpError && (error.status === 401 || error.status === 403)) {
        this.cache.delete(key);
      }
      return this.keepLastGood(key);
    }
  }

  private keepLastGood(key: string): PlanLimitReading | null {
    const at = this.now();
    const previous = this.cache.get(key);
    if (
      previous?.checkedAt != null &&
      previous.windows.length > 0 &&
      at - previous.checkedAt < STALE_MS
    ) {
      this.store(key, {
        windows: previous.windows,
        checkedAt: previous.checkedAt,
        freshUntil: previous.checkedAt,
        retryAt: at + FAILURE_RETRY_MS,
      });
      return {
        status: "stale",
        checkedAt: checkedAtIso(previous.checkedAt),
        windows: previous.windows,
      };
    }
    this.store(key, {
      windows: [],
      checkedAt: null,
      freshUntil: 0,
      retryAt: at + FAILURE_RETRY_MS,
    });
    return { status: "unavailable" };
  }

  private present(key: string, now: number): PlanLimitReading | null {
    const entry = this.cache.get(key);
    if (entry?.checkedAt != null && now - entry.checkedAt >= STALE_MS) {
      this.store(key, { windows: [], checkedAt: null, freshUntil: 0, retryAt: now });
      return { status: "unavailable" };
    }
    return this.view(entry, now);
  }

  private view(entry: Entry | undefined, now: number): PlanLimitReading | null {
    if (!entry || entry.checkedAt == null) return { status: "unavailable" };
    if (entry.windows.length === 0) return null;
    const checkedAt = checkedAtIso(entry.checkedAt);
    const windows = entry.windows.map((window) => ({ ...window }));
    if (now < entry.freshUntil) return { status: "fresh", checkedAt, windows };
    return { status: "stale", checkedAt, windows };
  }

  private store(key: string, entry: Entry) {
    this.cache.delete(key);
    while (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { ...entry, windows: entry.windows.map((window) => ({ ...window })) });
  }

  private untilAbort(
    task: Promise<PlanLimitReading | null>,
    signal: AbortSignal | undefined,
    onAbort: () => PlanLimitReading | null,
  ): Promise<PlanLimitReading | null> {
    if (!signal) return task;
    if (signal.aborted) return Promise.resolve(onAbort());
    return new Promise((resolve, reject) => {
      const abort = () => resolve(onAbort());
      signal.addEventListener("abort", abort, { once: true });
      task.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
}

export const planLimitsReader = new PlanLimitsReader();

function displayName(provider: string, label: string): string {
  return READERS[provider]?.name ?? label;
}

/** Allowances for the member's own signed-in connections. Other people's rows are not read. */
export async function readMemberPlanLimits(input: {
  prisma: Pick<PrismaClient, "userModelCredential" | "secret">;
  secretStore: Pick<SecretStore, "load">;
  userId: string;
  reader: Pick<PlanLimitsReader, "read">;
  onExpiredToken: (secretId: string, provider: string) => void;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PlanLimits[]> {
  const clock = input.now ?? Date.now;
  const rows = await input.prisma.userModelCredential.findMany({
    where: { userId: input.userId, provider: { in: PLAN_LIMIT_PROVIDERS } },
    select: { id: true, provider: true, label: true, secretId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!rows.length) return [];
  const secrets = await input.prisma.secret.findMany({
    where: { id: { in: rows.map((row) => row.secretId) }, userId: input.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  const ciphertexts = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const plans = await Promise.all(
    rows.map(async (row) => {
      const ciphertext = ciphertexts.get(row.secretId);
      if (!ciphertext) {
        return {
          credentialId: row.id,
          name: displayName(row.provider, row.label),
          label: row.label,
          reading: { status: "unavailable" as const },
        };
      }
      let credential: OAuthCredential | null = null;
      try {
        const stored = parseModelSecret(await input.secretStore.load(ciphertext, row.secretId));
        if (stored.kind !== "oauth" || stored.reconnectRequired) return null;
        credential = stored.credential;
      } catch {
        return null;
      }
      if (credential.expires <= clock()) input.onExpiredToken(row.secretId, row.provider);
      const reading = await input.reader.read({
        userId: input.userId,
        credentialId: row.id,
        secretId: row.secretId,
        provider: row.provider,
        credential,
        signal: input.signal,
      });
      if (!reading) return null;
      return {
        credentialId: row.id,
        name: displayName(row.provider, row.label),
        label: row.label,
        reading,
      };
    }),
  );
  return plans.filter((plan) => plan !== null);
}
