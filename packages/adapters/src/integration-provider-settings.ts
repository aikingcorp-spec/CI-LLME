import type {
  AdapterContext,
  ConnectorCall,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { IntegrationProviderConfig, IntegrationProviderId } from "@rakazo/contracts";
import { IntegrationProviderConfigSchema, IntegrationProviderIdSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { ComposioConnector } from "./composio-connector.js";
import { credentialDigest } from "./credential-digest.js";
import { PipedreamConnector } from "./pipedream-connector.js";

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

  async configured(id: IntegrationProviderId, userId?: string): Promise<boolean> {
    if (id === "composio")
      return Boolean(
        userId &&
          (await this.prisma.userIntegrationProviderConfig.findUnique({
            where: { userId_provider: { userId, provider: id } },
            select: { userId: true },
          })),
      );
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
  ): Promise<{ provider: ManagedConnectorProvider | undefined; ref: string | null }> {
    const key = id === "composio" ? `user:${userId}:${id}` : id;
    const row =
      id === "composio"
        ? userId
          ? await this.prisma.userIntegrationProviderConfig.findUnique({
              where: { userId_provider: { userId, provider: id } },
            })
          : null
        : await this.prisma.integrationProviderConfig.findUnique({ where: { id } });
    if (!row) {
      this.cache.delete(key);
      return { provider: id === "composio" ? undefined : this.fallbacks[id], ref: null };
    }
    let invalidated = false;
    const unsubscribe =
      this.secrets.onChange?.((ref) => {
        if (ref === row.ciphertext) invalidated = true;
      }) ?? (() => {});
    try {
      const plaintext = await this.secrets.load(row.ciphertext, `integration-provider:${key}`);
      if (invalidated) return await this.prepare(id, userId);
      const cached = this.cache.get(key);
      const digest = credentialDigest(plaintext);
      if (cached?.ciphertext === row.ciphertext && cached.digest === digest)
        return { provider: cached.adapter, ref: row.ciphertext };
      const config = IntegrationProviderConfigSchema.parse(JSON.parse(plaintext));
      if (config.provider !== id)
        throw new Error("Integration provider configuration does not match");
      const adapter = this.create(config);
      this.cache.set(key, { ciphertext: row.ciphertext, digest, adapter });
      return { provider: adapter, ref: row.ciphertext };
    } finally {
      unsubscribe();
    }
  }

  async save(config: IntegrationProviderConfig, context: AdapterContext): Promise<void> {
    if (config.provider === "composio" && !context.userId)
      throw new Error("A personal account is required");
    const adapter = this.create(config);
    try {
      // Exercises authenticated access before replacing working credentials.
      await adapter.listConnectedExternalIds(context);
    } catch {
      // Provider errors can contain credentials or account details.
      throw new Error("Could not verify these credentials");
    }
    const key =
      config.provider === "composio"
        ? `user:${context.userId}:${config.provider}`
        : config.provider;
    if (config.provider === "composio") {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('personal-composio'), hashtext(${context.userId}))`;
          if (
            await tx.connection.count({
              where: {
                userId: context.userId,
                connectorId: "composio",
                status: { in: ["connected", "pending"] },
              },
            })
          )
            throw new Error("Disconnect your Composio apps before replacing the key");
          const stored = await this.secrets.put(JSON.stringify(config), context, {
            recordId: `integration-provider:${key}`,
          });
          await tx.userIntegrationProviderConfig.upsert({
            where: { userId_provider: { userId: context.userId, provider: config.provider } },
            create: {
              userId: context.userId,
              provider: config.provider,
              ciphertext: stored.ciphertext,
            },
            update: { ciphertext: stored.ciphertext },
          });
        },
        { timeout: 30_000 },
      );
    } else {
      const stored = await this.secrets.put(JSON.stringify(config), context, {
        recordId: `integration-provider:${key}`,
      });
      await this.prisma.integrationProviderConfig.upsert({
        where: { id: config.provider },
        create: { id: config.provider, ciphertext: stored.ciphertext },
        update: { ciphertext: stored.ciphertext },
      });
    }
    // The store may have expired or invalidated this ref while persistence waited.
    // Re-resolve through it before retaining any provider credentials.
    this.cache.delete(key);
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

class ConfiguredIntegrationProvider implements ManagedConnectorProvider {
  constructor(
    private readonly id: IntegrationProviderId,
    private readonly settings: IntegrationProviderSettings,
    private readonly prepared?: ManagedConnectorProvider,
    private readonly preparedUserId?: string,
  ) {}
  async prepareForTransaction(userId: string) {
    const prepared = await this.settings.prepare(this.id, userId);
    return {
      provider: prepared.provider
        ? new ConfiguredIntegrationProvider(this.id, this.settings, prepared.provider, userId)
        : undefined,
      recheck: async (
        client: Pick<PrismaClient, "integrationProviderConfig" | "userIntegrationProviderConfig">,
      ) => {
        const current =
          this.id === "composio"
            ? await client.userIntegrationProviderConfig.findUnique({
                where: { userId_provider: { userId, provider: this.id } },
                select: { ciphertext: true },
              })
            : await client.integrationProviderConfig.findUnique({
                where: { id: this.id },
                select: { ciphertext: true },
              });
        return (current?.ciphertext ?? null) === prepared.ref;
      },
    };
  }
  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }
  async configuration(context: AdapterContext) {
    return {
      configured: Boolean(await this.resolve(context)),
      personal: this.id === "composio",
    };
  }
  private async resolve(context: AdapterContext) {
    if (this.prepared && this.preparedUserId !== context.userId)
      throw new Error("Integration credentials belong to another account");
    return this.prepared ?? this.settings.resolve(this.id, context.userId);
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
  userId: string,
) {
  return connector instanceof ConfiguredIntegrationProvider
    ? connector.prepareForTransaction(userId)
    : { provider: connector, recheck: undefined };
}
