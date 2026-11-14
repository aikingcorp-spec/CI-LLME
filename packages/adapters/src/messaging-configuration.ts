import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  MessagingInboundEvent,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { machineOwnerUserId } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { credentialDigest } from "./credential-digest.js";
import type { MessagingInboundLeadership } from "./messaging-inbound-lock.js";
import { createMessagingInboundLeadership } from "./messaging-inbound-lock.js";
import type { MessagingEnvironmentValues } from "./messaging-platforms.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";
import { isVitestRuntime } from "./test-runtime.js";

const CONNECTION_ID = "telegram";
const CONNECTION_LABEL = "Telegram";
const CONFIG_ID = "messaging-connection:telegram";
const SECRET_RECORD = "messaging-connection:telegram";
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 1000;

export type MessagingConnectionState = "unconfigured" | "starting" | "ready" | "error";

export interface MessagingConnectionView {
  id: string;
  label: string;
  configured: boolean;
  state: MessagingConnectionState;
  canConfigure: boolean;
}

export interface MessagingConnectionSetup {
  canManage: boolean;
  connections: MessagingConnectionView[];
}

/** The caller is not the account that owns this install. */
export class MessagingConfigurationDenied extends Error {
  constructor() {
    super("Only the owner of this computer can change messaging connections");
    this.name = "MessagingConfigurationDenied";
  }
}

/** The connection id is unknown, or this install does not accept a pasted credential for it. */
export class MessagingConfigurationRejected extends Error {
  constructor() {
    super("That messaging connection cannot be changed");
    this.name = "MessagingConfigurationRejected";
  }
}

type SavedCredential = { credential: string; webhookSecret: string };
type SavedRead =
  | { kind: "absent" }
  | { kind: "present"; saved: SavedCredential }
  | { kind: "error" };
type TelegramProbe = { botUserId?: string; isPolling?: boolean };
type RetrySchedule = (delayMs: number, run: () => void) => () => void;

export class MessagingConnectionRuntime {
  readonly surface: MessagingSurface;
  private readonly leadership: MessagingInboundLeadership;
  private readonly liveAdapters: boolean;
  private readonly schedule: RetrySchedule;
  // Env transports stay up across pasted-token changes. Only the default Telegram mount is replaced.
  private base: MessagingSurface | undefined;
  private managed: MessagingSurface | undefined;
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  private readonly origin = randomBytes(8).toString("hex");
  private tail: Promise<void> = Promise.resolve();
  private baseSignature = "";
  private managedKey = "";
  private readonly heldLocks = new Set<string>();
  private readonly watched = new Set<string>();
  private readonly lossUnsubs: Array<() => void> = [];
  private readonly retryCancel = new Map<string, () => void>();
  private readonly retryDelay = new Map<string, number>();
  private armed = false;
  private closed = false;
  private suppressReload = 0;
  private readonly state = new Map<string, MessagingConnectionState>();
  private unsubscribeSecret: (() => void) | undefined;
  private unsubscribeNotify: (() => void) | undefined;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      secrets: Pick<SecretStore, "put" | "load" | "delete" | "onChange">;
      baseEnv: MessagingEnvironmentValues;
      role: "receive" | "send";
      pool?: Parameters<typeof createMessagingInboundLeadership>[0];
      leadership?: MessagingInboundLeadership;
      ownerUserId?: () => Promise<string | null>;
      createWebhookSecret?: () => string;
      /** Vitest skips vendor adapters unless a test opts in. The server process is not Vitest. */
      pollInTests?: boolean;
      selectPlatforms?: (platforms: MessagingPlatform[]) => MessagingPlatform[];
      /** When this returns false, the install must not mount those platforms. */
      inboundAllowed?: (platforms: MessagingPlatform[]) => boolean;
      /** Test seam. Production uses a timer that is cancelled on shutdown. */
      schedule?: RetrySchedule;
    },
  ) {
    this.leadership =
      deps.leadership ??
      (deps.pool ? createMessagingInboundLeadership(deps.pool) : localLeadership());
    this.liveAdapters = Boolean(deps.pollInTests) || !isVitestRuntime();
    this.schedule = deps.schedule ?? defaultSchedule;
    this.surface = {
      describe: () => ({
        id: "messaging-connections",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { providers: this.platforms().map((platform) => platform.provider) },
      }),
      platforms: () => this.platforms(),
      onInbound: (sink) => {
        this.sink = sink;
        this.base?.onInbound(sink);
        this.managed?.onInbound(sink);
      },
      handleWebhook: (provider, request) =>
        this.targetFor(provider)?.handleWebhook(provider, request) ?? null,
      sendToThread: (request, context) => this.send(request, context),
      openDirectThread: async (provider, address, context) => {
        await this.prepareSend();
        const target = this.targetFor(provider);
        if (!target) throw new Error("Messaging provider unavailable");
        return target.openDirectThread(provider, address, context);
      },
      acknowledge: async (threadId, handle, context) => {
        await this.prepareSend();
        await this.targetFor(providerFromThread(threadId))?.acknowledge(threadId, handle, context);
      },
      fetchThreadHistory: (threadId, options, context) => {
        const target = this.targetFor(providerFromThread(threadId));
        if (!target?.fetchThreadHistory) return Promise.resolve([]);
        return target.fetchThreadHistory(threadId, options, context);
      },
      initialize: () => this.initialize(),
      shutdown: () => this.shutdown(),
    };
  }

  async start(): Promise<void> {
    this.unsubscribeSecret = this.deps.secrets.onChange(() => {
      this.scheduleReload();
    });
    this.unsubscribeNotify = this.leadership.onNotify((payload) => {
      const space = payload.indexOf(" ");
      if (space < 0) return;
      const origin = payload.slice(0, space);
      const connectionId = payload.slice(space + 1);
      if (origin === this.origin || connectionId.length === 0) return;
      this.scheduleReload();
    });
  }

  async list(userId: string): Promise<MessagingConnectionSetup> {
    await this.assertOwner(userId);
    return this.snapshot();
  }

  async set(
    userId: string,
    connectionId: string,
    credential: string,
  ): Promise<MessagingConnectionSetup> {
    await this.assertOwner(userId);
    this.assertConfigurable(connectionId);
    const trimmed = credential.trim();
    if (!trimmed) throw new MessagingConfigurationRejected();
    await this.exclusive(async () => {
      this.suppressReload += 1;
      try {
        await this.persist(userId, trimmed);
        this.state.set(CONNECTION_ID, "starting");
        if (!this.armed) return;
        try {
          await this.apply(this.deps.role === "receive");
        } catch {
          /* Saving succeeded. Ready stays false until a later init does. */
        }
      } finally {
        this.suppressReload -= 1;
      }
    });
    await this.leadership.notify(`${this.origin} ${CONNECTION_ID}`).catch(() => undefined);
    return this.snapshot();
  }

  async remove(userId: string, connectionId: string): Promise<MessagingConnectionSetup> {
    await this.assertOwner(userId);
    this.assertConfigurable(connectionId);
    await this.exclusive(async () => {
      this.suppressReload += 1;
      try {
        await this.deleteSaved();
        this.managedKey = "";
        this.state.set(CONNECTION_ID, "unconfigured");
        await this.stopManaged();
        this.clearRetry(CONNECTION_ID);
        await this.releaseLock(CONNECTION_ID);
      } finally {
        this.suppressReload -= 1;
      }
    });
    await this.leadership.notify(`${this.origin} ${CONNECTION_ID}`).catch(() => undefined);
    return this.snapshot();
  }

  async initialize(): Promise<void> {
    this.armed = true;
    await this.exclusive(() => this.apply(this.deps.role === "receive"));
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSecret?.();
    this.unsubscribeNotify?.();
    for (const stop of this.lossUnsubs) stop();
    for (const cancel of this.retryCancel.values()) cancel();
    this.retryCancel.clear();
    await this.exclusive(async () => {
      await this.stopManaged();
      await this.stopBase();
      for (const connectionId of [...this.heldLocks]) {
        this.heldLocks.delete(connectionId);
        await this.leadership.release(connectionId);
      }
    });
  }

  private scheduleReload(): void {
    if (this.closed || this.suppressReload > 0) return;
    void this.exclusive(async () => {
      if (this.closed) return;
      const inbound = this.deps.role === "receive" && this.armed;
      if (!inbound && this.deps.role === "receive") return;
      try {
        await this.apply(inbound);
      } catch {
        /* A peer's notify must not leave this process polling a credential that failed. */
      }
    });
  }

  private async send(
    request: MessagingSendRequest,
    context: AdapterContext,
  ): Promise<MessagingSendResult> {
    await this.prepareSend();
    const target = this.targetFor(providerFromThread(request.threadId));
    if (!target) throw new Error("Messaging provider unavailable");
    return target.sendToThread(request, context);
  }

  private prepareSend(): Promise<void> {
    const inbound = this.deps.role === "receive" && this.armed;
    return this.exclusive(() => this.apply(inbound));
  }

  private platforms() {
    return [...(this.base?.platforms() ?? []), ...(this.managed?.platforms() ?? [])];
  }

  private targetFor(provider: string): MessagingSurface | undefined {
    if (this.managed?.platforms().some((item) => item.provider === provider)) return this.managed;
    if (this.base?.platforms().some((item) => item.provider === provider)) return this.base;
    return undefined;
  }

  private async snapshot(): Promise<MessagingConnectionSetup> {
    const envManaged = this.envManaged();
    const row = envManaged ? null : await this.configRow();
    const configured = envManaged || Boolean(row);
    const current = this.state.get(CONNECTION_ID);
    const connectionState: MessagingConnectionState = !configured
      ? "unconfigured"
      : (current ?? "starting");
    return {
      canManage: true,
      connections: [
        {
          id: CONNECTION_ID,
          label: CONNECTION_LABEL,
          configured,
          state: connectionState,
          canConfigure: !envManaged,
        },
      ],
    };
  }

  private assertConfigurable(connectionId: string): void {
    if (connectionId !== CONNECTION_ID || this.envManaged()) {
      throw new MessagingConfigurationRejected();
    }
  }

  private envManaged(): boolean {
    return Boolean(this.deps.baseEnv.telegramBotToken && this.deps.baseEnv.telegramWebhookSecret);
  }

  private async assertOwner(userId: string): Promise<void> {
    const owner = await (this.deps.ownerUserId ?? (() => machineOwnerUserId(this.deps.prisma)))();
    if (!owner || owner !== userId) throw new MessagingConfigurationDenied();
  }

  private async apply(startInbound: boolean): Promise<void> {
    if (this.closed) return;
    if (!this.liveAdapters) {
      await this.rememberOffline();
      return;
    }
    await this.reconcileBase(startInbound);
    await this.reconcileManaged(startInbound);
  }

  private async rememberOffline(): Promise<void> {
    if (this.envManaged()) {
      this.state.set(CONNECTION_ID, "starting");
      return;
    }
    const read = await this.readSaved();
    if (read.kind === "error") this.state.set(CONNECTION_ID, "error");
    else if (read.kind === "present") this.state.set(CONNECTION_ID, "starting");
    else this.state.set(CONNECTION_ID, "unconfigured");
  }

  private stableEnv(): MessagingEnvironmentValues {
    if (this.envManaged()) return this.deps.baseEnv;
    return {
      ...this.deps.baseEnv,
      telegramBotToken: undefined,
      telegramWebhookSecret: undefined,
    };
  }

  private async reconcileBase(startInbound: boolean): Promise<void> {
    const quiet = this.platformsFor(this.stableEnv(), false);
    const loud = startInbound ? this.platformsFor(this.stableEnv(), true) : quiet;
    const loudById = new Map(loud.map((platform) => [platform.provider, platform]));
    const chosen: MessagingPlatform[] = [];
    const modes: string[] = [];
    for (const platform of quiet) {
      const polled = loudById.get(platform.provider);
      if (!startInbound || !polled || !longPolls(platform.provider)) {
        chosen.push(platform);
        modes.push(`${platform.provider}:hook`);
        continue;
      }
      this.watch(platform.provider);
      const acquired = await this.leadership.tryAcquire(platform.provider);
      if (!acquired) {
        this.heldLocks.delete(platform.provider);
        chosen.push(platform);
        modes.push(`${platform.provider}:wait`);
        this.scheduleRetry(platform.provider);
        continue;
      }
      this.heldLocks.add(platform.provider);
      this.clearRetry(platform.provider);
      this.retryDelay.delete(platform.provider);
      chosen.push(polled);
      modes.push(`${platform.provider}:poll`);
    }
    const signature = modes.sort().join("|");
    const wanted = chosen.length > 0;
    if (signature === this.baseSignature && Boolean(this.base) === wanted) {
      if (this.envManaged()) this.markEnvState(chosen, modes);
      return;
    }
    try {
      await this.mountBase(chosen);
    } catch (error) {
      await this.stopBase();
      this.baseSignature = "";
      if (this.envManaged()) {
        this.state.set(CONNECTION_ID, "error");
        this.logFailure(error, [
          this.deps.baseEnv.telegramBotToken ?? "",
          this.deps.baseEnv.telegramWebhookSecret ?? "",
        ]);
      }
      throw error;
    }
    this.baseSignature = signature;
    if (!this.envManaged()) return;
    if (!modes.includes(`${CONNECTION_ID}:poll`)) {
      this.state.set(CONNECTION_ID, "starting");
      return;
    }
    if (!healthy(probeOf(chosen))) {
      await this.releaseLock(CONNECTION_ID);
      this.clearRetry(CONNECTION_ID);
      const rest = chosen.filter((platform) => platform.provider !== CONNECTION_ID);
      this.baseSignature = "";
      await this.mountBase(rest);
      this.baseSignature = rest
        .map((platform) => `${platform.provider}:hook`)
        .sort()
        .join("|");
      this.state.set(CONNECTION_ID, "error");
      this.logFailure(new Error("messaging connection did not become ready"), [
        this.deps.baseEnv.telegramBotToken ?? "",
        this.deps.baseEnv.telegramWebhookSecret ?? "",
      ]);
      throw new Error("messaging connection is not ready");
    }
    this.state.set(CONNECTION_ID, "ready");
  }

  private markEnvState(chosen: MessagingPlatform[], modes: string[]): void {
    if (!modes.includes(`${CONNECTION_ID}:poll`)) {
      const current = this.state.get(CONNECTION_ID);
      if (current !== "ready" && current !== "error") this.state.set(CONNECTION_ID, "starting");
      return;
    }
    if (healthy(probeOf(chosen))) this.state.set(CONNECTION_ID, "ready");
  }

  private async reconcileManaged(startInbound: boolean): Promise<void> {
    if (this.envManaged()) return;
    const read = await this.readSaved();
    if (read.kind === "error") {
      await this.stopManaged();
      this.clearRetry(CONNECTION_ID);
      await this.releaseLock(CONNECTION_ID);
      this.managedKey = "error";
      this.state.set(CONNECTION_ID, "error");
      return;
    }
    if (read.kind === "absent") {
      await this.stopManaged();
      this.clearRetry(CONNECTION_ID);
      await this.releaseLock(CONNECTION_ID);
      this.managedKey = "";
      this.state.set(CONNECTION_ID, "unconfigured");
      return;
    }
    const { saved } = read;
    const digest = credentialDigest(`${saved.credential}:${saved.webhookSecret}`);
    const secrets = [saved.credential, saved.webhookSecret];
    if (!startInbound) {
      if (this.managedKey === `${digest}:send` && this.managed) return;
      await this.mountManaged(this.managedPlatforms(saved, false));
      this.managedKey = `${digest}:send`;
      this.state.set(CONNECTION_ID, "starting");
      return;
    }
    this.watch(CONNECTION_ID);
    const acquired = await this.leadership.tryAcquire(CONNECTION_ID);
    if (!acquired) {
      this.heldLocks.delete(CONNECTION_ID);
      if (this.managedKey !== `${digest}:waiting`) {
        await this.stopManaged();
        this.managedKey = `${digest}:waiting`;
        this.state.set(CONNECTION_ID, "starting");
      }
      this.scheduleRetry(CONNECTION_ID);
      return;
    }
    this.heldLocks.add(CONNECTION_ID);
    this.clearRetry(CONNECTION_ID);
    this.retryDelay.delete(CONNECTION_ID);
    if (this.managedKey === digest && this.managed) return;
    if (this.managedKey === `${digest}:error` && !this.managed) return;
    this.state.set(CONNECTION_ID, "starting");
    const platforms = this.managedPlatforms(saved, true);
    try {
      await this.mountManaged(platforms);
    } catch (error) {
      await this.failManaged(digest, error, secrets);
      throw new Error("messaging connection is not ready");
    }
    if (
      !platforms.some((platform) => platform.provider === CONNECTION_ID) ||
      !healthy(probeOf(platforms))
    ) {
      await this.failManaged(
        digest,
        new Error("messaging connection did not become ready"),
        secrets,
      );
      throw new Error("messaging connection is not ready");
    }
    this.managedKey = digest;
    this.state.set(CONNECTION_ID, "ready");
  }

  private async failManaged(digest: string, error: unknown, secrets: string[]): Promise<void> {
    await this.stopManaged();
    this.managedKey = `${digest}:error`;
    this.state.set(CONNECTION_ID, "error");
    this.logFailure(error, secrets);
  }

  private managedPlatforms(saved: SavedCredential, poll: boolean): MessagingPlatform[] {
    return this.platformsFor(
      { telegramBotToken: saved.credential, telegramWebhookSecret: saved.webhookSecret },
      poll,
    );
  }

  private scheduleRetry(connectionId: string): void {
    if (this.closed || this.retryCancel.has(connectionId)) return;
    const delay = this.retryDelay.get(connectionId) ?? RETRY_MIN_MS;
    this.retryDelay.set(connectionId, Math.min(delay * 2, RETRY_MAX_MS));
    const cancel = this.schedule(delay, () => {
      this.retryCancel.delete(connectionId);
      if (this.closed || !this.armed || this.deps.role !== "receive") return;
      void this.exclusive(async () => {
        if (this.closed || !this.armed) return;
        try {
          await this.apply(true);
        } catch {
          /* The connection state already records the failure. */
        }
      });
    });
    this.retryCancel.set(connectionId, cancel);
  }

  private clearRetry(connectionId: string): void {
    this.retryCancel.get(connectionId)?.();
    this.retryCancel.delete(connectionId);
  }

  private watch(connectionId: string): void {
    if (this.watched.has(connectionId)) return;
    this.watched.add(connectionId);
    const stop = this.leadership.onLost(connectionId, () => {
      this.heldLocks.delete(connectionId);
      if (connectionId === CONNECTION_ID && !this.envManaged()) this.managedKey = "";
      else this.baseSignature = "";
      void this.exclusive(async () => {
        if (connectionId === CONNECTION_ID && !this.envManaged()) await this.stopManaged();
        else await this.stopBase();
        if (this.closed || !this.armed || this.deps.role !== "receive") return;
        try {
          await this.apply(true);
        } catch {
          /* The lock is gone, so this process is not polling that connection. */
        }
      });
    });
    this.lossUnsubs.push(stop);
  }

  private async releaseLock(connectionId: string): Promise<void> {
    if (!this.heldLocks.delete(connectionId)) return;
    await this.leadership.release(connectionId);
  }

  private platformsFor(values: MessagingEnvironmentValues, poll: boolean): MessagingPlatform[] {
    const select = this.deps.selectPlatforms ?? ((items: MessagingPlatform[]) => items);
    let platforms = select(messagingPlatformsFromEnv(values, { pollInboundMessages: poll }));
    const allowed = this.deps.inboundAllowed;
    if (allowed && !allowed(platforms)) {
      const rest = platforms.filter((platform) => platform.provider !== CONNECTION_ID);
      platforms = allowed(rest) ? rest : [];
    }
    return platforms;
  }

  private async mountBase(platforms: MessagingPlatform[]): Promise<void> {
    await this.stopBase();
    if (platforms.length === 0) return;
    const next = new ChatSdkMessagingSurface(platforms);
    if (this.sink) next.onInbound(this.sink);
    this.base = next;
    await next.initialize?.();
  }

  private async mountManaged(platforms: MessagingPlatform[]): Promise<void> {
    await this.stopManaged();
    if (platforms.length === 0) return;
    const next = new ChatSdkMessagingSurface(platforms);
    if (this.sink) next.onInbound(this.sink);
    this.managed = next;
    await next.initialize?.();
  }

  private async stopBase(): Promise<void> {
    const previous = this.base;
    this.base = undefined;
    if (previous) await previous.shutdown?.();
  }

  private async stopManaged(): Promise<void> {
    const previous = this.managed;
    this.managed = undefined;
    if (previous) await previous.shutdown?.();
  }

  private async persist(userId: string, credential: string): Promise<void> {
    const webhookSecret = (this.deps.createWebhookSecret ?? defaultWebhookSecret)();
    const previous = await this.configRow();
    const stored = await this.deps.secrets.put(
      JSON.stringify({ credential, webhookSecret } satisfies SavedCredential),
      secretContext(userId),
      { recordId: SECRET_RECORD },
    );
    await this.deps.prisma.integrationProviderConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, ciphertext: stored.ciphertext },
      update: { ciphertext: stored.ciphertext },
    });
    if (previous && previous.ciphertext !== stored.ciphertext) {
      await deleteSecretBestEffort(this.deps.secrets, previous.ciphertext, SECRET_RECORD);
    }
  }

  private async deleteSaved(): Promise<void> {
    const previous = await this.configRow();
    if (!previous) return;
    await this.deps.prisma.integrationProviderConfig.delete({ where: { id: CONFIG_ID } });
    await deleteSecretBestEffort(this.deps.secrets, previous.ciphertext, SECRET_RECORD);
  }

  private configRow() {
    return this.deps.prisma.integrationProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  }

  private async readSaved(): Promise<SavedRead> {
    const row = await this.configRow();
    if (!row) return { kind: "absent" };
    let plaintext: string;
    try {
      plaintext = await this.deps.secrets.load(row.ciphertext, SECRET_RECORD);
    } catch {
      return { kind: "error" };
    }
    const saved = parseSaved(plaintext);
    if (!saved) return { kind: "error" };
    return { kind: "present", saved };
  }

  private logFailure(error: unknown, secrets: string[]): void {
    const detail = error instanceof Error ? error.message : "messaging connection failed";
    getLogger().error("messaging connection failed to start", undefined, {
      detail: redact(detail, secrets),
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function longPolls(provider: string): boolean {
  return (
    provider === "telegram" ||
    provider.startsWith("telegram-") ||
    provider === "photon" ||
    provider.startsWith("photon-")
  );
}

function probeOf(platforms: MessagingPlatform[]): TelegramProbe {
  const adapter = platforms.find((platform) => platform.provider === CONNECTION_ID)?.adapter;
  if (!adapter) return {};
  const botUserId = Reflect.get(adapter, "botUserId");
  const isPolling = Reflect.get(adapter, "isPolling");
  return {
    botUserId: typeof botUserId === "string" ? botUserId : undefined,
    isPolling: typeof isPolling === "boolean" ? isPolling : undefined,
  };
}

function healthy(probe: TelegramProbe): boolean {
  return Boolean(probe.botUserId) && probe.isPolling === true;
}

function providerFromThread(threadId: string): string {
  const index = threadId.indexOf(":");
  return index === -1 ? threadId : threadId.slice(0, index);
}

function defaultSchedule(delayMs: number, run: () => void): () => void {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
}

function defaultWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

function secretContext(userId: string): AdapterContext {
  return {
    operationId: "messaging-connection",
    traceId: "messaging-connection",
    spaceId: "",
    userId,
    signal: new AbortController().signal,
  };
}

function parseSaved(plaintext: string): SavedCredential | undefined {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const credential = readString(value, "credential");
  const webhookSecret = readString(value, "webhookSecret");
  if (!credential || !webhookSecret) return undefined;
  return { credential, webhookSecret };
}

function readString(value: object, key: string): string {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : "";
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (line, secret) => (secret ? line.split(secret).join("[redacted]") : line),
    text,
  );
}

function localLeadership(): MessagingInboundLeadership {
  const held = new Set<string>();
  const notifyListeners = new Set<(payload: string) => void>();
  const lostListeners = new Map<string, Set<() => void>>();
  return {
    async tryAcquire(connectionId) {
      held.add(connectionId);
      return true;
    },
    async release(connectionId) {
      held.delete(connectionId);
    },
    async notify(connectionId) {
      for (const listener of notifyListeners) listener(connectionId);
    },
    onNotify(listener) {
      notifyListeners.add(listener);
      return () => notifyListeners.delete(listener);
    },
    onLost(connectionId, listener) {
      const listeners = lostListeners.get(connectionId) ?? new Set();
      listeners.add(listener);
      lostListeners.set(connectionId, listeners);
      return () => listeners.delete(listener);
    },
  };
}
