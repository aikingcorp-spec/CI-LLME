import type {
  AdapterContext,
  ConnectorCall,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { IntegrationProviderConfig, IntegrationProviderId } from "@rakazo/contracts";
import { IntegrationProviderConfigSchema, IntegrationProviderIdSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext, runAsSystemInTransaction } from "@rakazo/db";
import { ComposioConnector } from "./composio-connector.js";
import { credentialDigest } from "./credential-digest.js";
import {
  credentialVerificationError,
  integrationProviderUnreachable,
} from "./credential-reachability.js";
import type { PersonalIntegrationSettings } from "./personal-integration-settings.js";
import { PipedreamConnector } from "./pipedream-connector.js";

const PLUGIN_SLUG_PROVIDER: IntegrationProviderId = "composio";

/** Resolve persisted credentials on every operation so API and workers observe changes.
 * Cache adapters by ciphertext to preserve sessions without retaining old credentials. */
export class IntegrationProviderSettings {
  private readonly cache = new Map<
    string,
    { ciphertext: string; digest: string; adapter: ManagedConnectorProvider }
  >();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly identitySecret: string,
    private readonly fallbacks: Partial<
      Record<IntegrationProviderId, ManagedConnectorProvider>
    > = {},
    private readonly factory?: (config: IntegrationProviderConfig) => ManagedConnectorProvider,
    private readonly personal?: PersonalIntegrationSettings,
    /** The account that owns this install; its key serves every account here. */
    private readonly owner?: () => Promise<string | null>,
  ) {
    this.secrets.onChange?.((ref) => {
      for (const [id, entry] of this.cache) if (entry.ciphertext === ref) this.cache.delete(id);
    });
  }

  private create(config: IntegrationProviderConfig): ManagedConnectorProvider {
    if (this.factory) return this.factory(config);
    return config.provider === "composio"
      ? new ComposioConnector({ apiKey: config.apiKey })
      : new PipedreamConnector({ ...config, identitySecret: this.identitySecret });
  }

  /** Whose saved key serves this account: the install owner's when an owner is known. */
  private async keyAccount(userId: string): Promise<string> {
    if (!this.owner) return userId;
    return (await this.owner()) ?? "";
  }

  /**
   * The shared key row belongs to the install owner. A tenant connection can see
   * only the signed-in account's rows, so resolution reads the owner row as system
   * and returns before any provider call. An open tenant transaction keeps the
   * connection it checked out, so a recheck turns the bypass on for that
   * connection and restores the previous settings before the caller continues.
   */
  private readSharedInstallKey<T>(
    client: Pick<PrismaClient, "userIntegrationProviderConfig"> | undefined,
    read: (query: Pick<PrismaClient, "userIntegrationProviderConfig">) => Promise<T>,
  ): Promise<T> {
    if (currentDbContext()?.kind !== "tenant") {
      return read(client ?? this.prisma);
    }
    const reason = "read the shared integration key for this install";
    if (client && client !== this.prisma && hasQueryRaw(client)) {
      return runAsSystemInTransaction(client, reason, () => read(client));
    }
    return this.prisma.$transaction((tx) => runAsSystemInTransaction(tx, reason, () => read(tx)));
  }
  /** Only the install owner pastes, replaces or removes the key everyone here shares. */
  async canManageKey(userId: string): Promise<boolean> {
    if (!this.personal || !userId) return false;
    return !this.owner || (await this.owner()) === userId;
  }
  private async assertCanManageKey(userId: string | undefined): Promise<void> {
    if (!(await this.canManageKey(userId ?? ""))) throw new IntegrationKeyOwnerError();
  }
  async needsPersonalKey(userId: string): Promise<boolean> {
    if (!this.personal) return false;
    const account = await this.keyAccount(userId);
    if (!account) return true;
    const read = (query: Pick<PrismaClient, "userIntegrationProviderConfig">) =>
      this.personal!.configured(account, PLUGIN_SLUG_PROVIDER, query);
    const configured = this.owner
      ? await this.readSharedInstallKey(undefined, read)
      : await this.personal.configured(account, PLUGIN_SLUG_PROVIDER);
    return !configured;
  }
  async preparePersonalKey(
    apiKey: string,
    context: AdapterContext,
  ): ReturnType<PersonalIntegrationSettings["prepareSave"]> {
    if (!this.personal) throw new Error("Personal integration setup is unavailable");
    await this.assertCanManageKey(context.userId);
    return this.personal.prepareSave({ provider: "composio", apiKey }, context);
  }
  /** Verifies the key with the provider, then stores it encrypted as the shared key of this install. */
  async savePersonalKey(apiKey: string, context: AdapterContext): Promise<void> {
    if (!this.personal) throw new Error("Personal integration setup is unavailable");
    await this.assertCanManageKey(context.userId);
    await this.personal.save({ provider: "composio", apiKey }, context);
  }
  async revokePersonal(
    userId: string,
    client?: Pick<PrismaClient, "userIntegrationProviderConfig">,
  ): Promise<void> {
    if (!this.personal) throw new Error("Personal integration setup is unavailable");
    await this.assertCanManageKey(userId);
    await this.personal.revoke(userId, PLUGIN_SLUG_PROVIDER, client);
  }
  async configured(id: IntegrationProviderId): Promise<boolean> {
    return (
      Boolean(
        await this.prisma.integrationProviderConfig.findUnique({
          where: { id },
          select: { id: true },
        }),
      ) || Boolean(this.fallbacks[id])
    );
  }

  async resolve(
    id: IntegrationProviderId,
    userId?: string,
  ): Promise<ManagedConnectorProvider | undefined> {
    return (await this.prepare(id, userId)).provider;
  }

  async prepare(
    id: IntegrationProviderId,
    userId?: string,
  ): Promise<{
    provider: ManagedConnectorProvider | undefined;
    ref: string | null;
    recheck?: (client: Pick<PrismaClient, "userIntegrationProviderConfig">) => Promise<boolean>;
  }> {
    if (this.personal && userId !== undefined && id === PLUGIN_SLUG_PROVIDER) {
      const account = userId ? await this.keyAccount(userId) : "";
      if (!account) return { provider: undefined, ref: null };
      const prepared = this.owner
        ? await this.personal.prepare(account, id, (read, client) =>
            this.readSharedInstallKey(client, read),
          )
        : await this.personal.prepare(account, id);
      return {
        provider: prepared?.provider,
        ref: null,
        recheck: prepared?.recheck,
      };
    }
    const row = await this.prisma.integrationProviderConfig.findUnique({ where: { id } });
    if (!row) {
      this.cache.delete(id);
      return { provider: this.fallbacks[id], ref: null };
    }
    let invalidated = false;
    const unsubscribe =
      this.secrets.onChange?.((ref) => {
        if (ref === row.ciphertext) invalidated = true;
      }) ?? (() => {});
    try {
      const plaintext = await this.secrets.load(row.ciphertext, `integration-provider:${id}`);
      if (invalidated) return await this.prepare(id);
      const cached = this.cache.get(id);
      const digest = credentialDigest(plaintext);
      if (cached?.ciphertext === row.ciphertext && cached.digest === digest)
        return { provider: cached.adapter, ref: row.ciphertext };
      const config = IntegrationProviderConfigSchema.parse(JSON.parse(plaintext));
      if (config.provider !== id)
        throw new Error("Integration provider configuration does not match");
      const adapter = this.create(config);
      this.cache.set(id, { ciphertext: row.ciphertext, digest, adapter });
      return { provider: adapter, ref: row.ciphertext };
    } finally {
      unsubscribe();
    }
  }

  async save(config: IntegrationProviderConfig, context: AdapterContext): Promise<void> {
    const adapter = this.create(config);
    try {
      // Exercises authenticated access before replacing working credentials.
      await adapter.listConnectedExternalIds(context);
    } catch (error) {
      // Provider errors can contain credentials or account details.
      throw credentialVerificationError(error);
    }
    const stored = await this.secrets.put(JSON.stringify(config), context, {
      recordId: `integration-provider:${config.provider}`,
    });
    await this.prisma.integrationProviderConfig.upsert({
      where: { id: config.provider },
      create: { id: config.provider, ciphertext: stored.ciphertext },
      update: { ciphertext: stored.ciphertext },
    });
    // The store may have expired or invalidated this ref while persistence waited.
    // Re-resolve through it before retaining any provider credentials.
    this.cache.delete(config.provider);
  }

  /** Connected app slugs from the provider whose app ids match plugin slugs. */
  async listConnectedPluginSlugs(userId: string): Promise<string[]> {
    const provider = await this.resolve(PLUGIN_SLUG_PROVIDER, userId);
    if (!provider) return [];
    return provider.listConnectedExternalIds({
      userId,
      spaceId: "",
      operationId: "connections.sync",
      traceId: "connections.sync",
      signal: AbortSignal.timeout(15_000),
    });
  }

  providers(): ManagedConnectorProvider[] {
    return IntegrationProviderIdSchema.options.map(
      (id) => new ConfiguredIntegrationProvider(id, this),
    );
  }

  /** Warm catalogs for env- and DB-configured providers. Fire-and-forget. */
  warmDirectories(): void {
    for (const id of IntegrationProviderIdSchema.options) {
      void this.resolve(id)
        .then((provider) => provider?.warmDirectory?.())
        .catch(() => undefined);
    }
  }
}

function hasQueryRaw(client: object): client is Pick<PrismaClient, "$queryRaw"> {
  return "$queryRaw" in client && typeof client.$queryRaw === "function";
}

/** Someone other than the install owner tried to change the shared integration key. */
export class IntegrationKeyOwnerError extends Error {
  constructor() {
    super("Only the owner of this install can change the integration key");
    this.name = "IntegrationKeyOwnerError";
  }
}

class ConfiguredIntegrationProvider implements ManagedConnectorProvider {
  readonly resolveConnectedAccountId?: ManagedConnectorProvider["resolveConnectedAccountId"];
  readonly cancelAuthorizationRequest?: ManagedConnectorProvider["cancelAuthorizationRequest"];
  readonly revokeUnreferencedAccounts?: ManagedConnectorProvider["revokeUnreferencedAccounts"];

  constructor(
    private readonly id: IntegrationProviderId,
    private readonly settings: IntegrationProviderSettings,
    private readonly prepared?: ManagedConnectorProvider,
    private readonly preparedUserId?: string,
  ) {
    // Only a prepared provider is known up front; callers branch on which of these exist.
    this.resolveConnectedAccountId = prepared?.resolveConnectedAccountId?.bind(prepared);
    this.cancelAuthorizationRequest = prepared?.cancelAuthorizationRequest?.bind(prepared);
    this.revokeUnreferencedAccounts = prepared?.revokeUnreferencedAccounts?.bind(prepared);
  }
  async prepareForTransaction(userId?: string) {
    const prepared = await this.settings.prepare(this.id, userId);
    return {
      provider: prepared.provider
        ? new ConfiguredIntegrationProvider(this.id, this.settings, prepared.provider, userId)
        : undefined,
      recheck: async (
        client: Pick<PrismaClient, "integrationProviderConfig" | "userIntegrationProviderConfig">,
      ) => {
        if (prepared.recheck) return prepared.recheck(client);
        if (userId && !prepared.provider) return false;
        const current = await client.integrationProviderConfig.findUnique({
          where: { id: this.id },
          select: { ciphertext: true },
        });
        return (current?.ciphertext ?? null) === prepared.ref;
      },
    };
  }
  async needsPersonalKey(context: AdapterContext) {
    return this.id === PLUGIN_SLUG_PROVIDER && this.settings.needsPersonalKey(context.userId ?? "");
  }
  async canManageKey(context: AdapterContext) {
    return this.id === PLUGIN_SLUG_PROVIDER && this.settings.canManageKey(context.userId ?? "");
  }
  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  private async resolve(context: AdapterContext) {
    if (this.preparedUserId && this.preparedUserId !== context.userId)
      throw new Error("Integration account does not match");
    return this.prepared ?? this.settings.resolve(this.id, context.userId ?? "");
  }
  private async required(context: AdapterContext) {
    const provider = await this.resolve(context);
    if (!provider) throw new Error("Set up an integration provider in Integrations first");
    return provider;
  }
  async catalog(context: AdapterContext, query?: string) {
    return (await this.resolve(context))?.catalog(context, query) ?? [];
  }
  async discoverTools(context: AdapterContext) {
    return (await this.resolve(context))?.discoverTools(context) ?? [];
  }
  async listConnectedExternalIds(context: AdapterContext) {
    return (await this.resolve(context))?.listConnectedExternalIds(context) ?? [];
  }
  async listReconnectRefs(context: AdapterContext) {
    return (await (await this.resolve(context))?.listReconnectRefs?.(context)) ?? [];
  }
  async connectionReady(context: AdapterContext, externalId: string) {
    return (await this.required(context)).connectionReady(context, externalId);
  }
  async begin(request: Parameters<ManagedConnectorProvider["begin"]>[0], context: AdapterContext) {
    return (await this.required(context)).begin(request, context);
  }
  async complete(
    request: Parameters<ManagedConnectorProvider["complete"]>[0],
    context: AdapterContext,
  ) {
    return (await this.required(context)).complete(request, context);
  }
  async revoke(ref: string, context: AdapterContext) {
    return (await this.required(context)).revoke(ref, context);
  }
  async resolveCall(call: ConnectorCall, context: AdapterContext) {
    const provider = await (call.route ? this.required(context) : this.resolve(context));
    return provider?.resolveCall?.(call, context);
  }
  async *execute(call: ConnectorCall, context: AdapterContext) {
    yield* (await this.required(context)).execute(call, context);
  }
}

export async function prepareManagedConnectorForTransaction(
  connector: ManagedConnectorProvider,
  userId?: string,
) {
  return connector instanceof ConfiguredIntegrationProvider
    ? connector.prepareForTransaction(userId)
    : { provider: connector, recheck: undefined };
}

/** A saved personal key that the provider rejected. The error is not returned. */
export async function personalKeyRejected(
  providers: ManagedConnectorProvider[],
  context: AdapterContext,
): Promise<boolean> {
  for (const provider of providers) {
    if (
      provider instanceof ConfiguredIntegrationProvider &&
      provider.describe().id === PLUGIN_SLUG_PROVIDER &&
      !(await provider.needsPersonalKey(context))
    ) {
      try {
        await provider.listConnectedExternalIds(context);
      } catch (error) {
        // A timeout is not a rejected key. Replacing it would drop a working credential.
        if (integrationProviderUnreachable(error)) return false;
        return true;
      }
    }
  }
  return false;
}

export async function needsPersonalIntegrationKey(
  providers: ManagedConnectorProvider[],
  context: AdapterContext,
) {
  for (const provider of providers) {
    if (
      provider instanceof ConfiguredIntegrationProvider &&
      (await provider.needsPersonalKey(context))
    )
      return true;
  }
  return false;
}

/** Whether this account may paste or replace the shared integration key of this install. */
export async function canManageIntegrationKey(
  providers: ManagedConnectorProvider[],
  context: AdapterContext,
) {
  for (const provider of providers) {
    if (provider instanceof ConfiguredIntegrationProvider && (await provider.canManageKey(context)))
      return true;
  }
  return false;
}
