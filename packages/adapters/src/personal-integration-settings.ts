import { randomUUID } from "node:crypto";
import type { AdapterContext, ManagedConnectorProvider, SecretStore } from "@rakazo/adapter-kit";
import type { IntegrationProviderConfig, IntegrationProviderId } from "@rakazo/contracts";
import { IntegrationProviderConfigSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { credentialVerificationError } from "./credential-reachability.js";

type Client = Pick<PrismaClient, "userIntegrationProviderConfig">;
type Read = <T>(read: (client: Client) => Promise<T>, client?: Client) => Promise<T>;

export interface LegacyPersonalIntegration {
  userId: string;
  provider: IntegrationProviderId;
  ciphertext: string;
  revision: number;
}

async function readLegacyIntegration(
  row: Readonly<LegacyPersonalIntegration>,
  source: Pick<SecretStore, "load">,
  context: AdapterContext,
) {
  if (!context.userId || context.userId !== row.userId) {
    throw new Error("Legacy integration account does not match");
  }
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error("Invalid legacy integration revision");
  }
  context.signal.throwIfAborted();
  const plaintext = await source.load(row.ciphertext, {
    recordId: `integration-provider:user:${row.userId}:${row.provider}`,
    signal: context.signal,
  });
  const config = IntegrationProviderConfigSchema.parse(JSON.parse(plaintext));
  if (config.provider !== row.provider) {
    throw new Error("Legacy integration configuration does not match");
  }
  return plaintext;
}

async function bindLegacyIntegration(
  row: Readonly<LegacyPersonalIntegration>,
  plaintext: string,
  destination: Pick<SecretStore, "put" | "load">,
  context: AdapterContext,
) {
  const revision = `legacy-${row.revision}`;
  const recordId = `integration-provider:user:${row.userId}:${row.provider}:${revision}`;
  const stored = await destination.put(plaintext, context, { recordId });
  if (
    (await destination.load(stored.ciphertext, { recordId, signal: context.signal })) !== plaintext
  ) {
    throw new Error("Imported integration did not round-trip");
  }
  context.signal.throwIfAborted();
  return { userId: row.userId, provider: row.provider, revision, ciphertext: stored.ciphertext };
}

export async function importLegacyPersonalIntegration(
  prisma: Client,
  row: Readonly<LegacyPersonalIntegration>,
  source: Pick<SecretStore, "load">,
  destination: SecretStore,
  context: AdapterContext,
): Promise<"imported" | "existing"> {
  const plaintext = await readLegacyIntegration(row, source, context);
  const revision = `legacy-${row.revision}`;
  const recordId = `integration-provider:user:${row.userId}:${row.provider}:${revision}`;
  const where = { userId_provider: { userId: row.userId, provider: row.provider } };
  const existing = await prisma.userIntegrationProviderConfig.findUnique({ where });
  if (existing) {
    if (
      existing.revision !== revision ||
      (await destination.load(existing.ciphertext, { recordId, signal: context.signal })) !==
        plaintext
    ) {
      throw new Error("Destination integration already exists");
    }
    return "existing";
  }
  await prisma.userIntegrationProviderConfig.create({
    data: await bindLegacyIntegration(row, plaintext, destination, context),
  });
  return "imported";
}

/** Personal credentials never resolve through deployment defaults or another account. */
export class PersonalIntegrationSettings {
  constructor(
    private readonly prisma: Client,
    private readonly secrets: SecretStore,
    private readonly create: (config: IntegrationProviderConfig) => ManagedConnectorProvider,
  ) {}

  async configured(
    userId: string,
    provider: IntegrationProviderId,
    client: Client = this.prisma,
  ): Promise<boolean> {
    return Boolean(
      await client.userIntegrationProviderConfig.findUnique({
        where: { userId_provider: { userId, provider } },
        select: { userId: true },
      }),
    );
  }

  async importLegacy(
    row: Readonly<LegacyPersonalIntegration>,
    source: Pick<SecretStore, "load">,
    context: AdapterContext,
  ): Promise<"imported" | "existing"> {
    return importLegacyPersonalIntegration(this.prisma, row, source, this.secrets, context);
  }

  async prepare(
    userId: string,
    provider: IntegrationProviderId,
    read: Read = (query, client = this.prisma) => query(client),
  ) {
    if (!userId) throw new Error("A personal account is required");
    const where = { userId_provider: { userId, provider } };
    const row = await read((client) => client.userIntegrationProviderConfig.findUnique({ where }));
    if (!row) return undefined;
    const config = IntegrationProviderConfigSchema.parse(
      JSON.parse(
        await this.secrets.load(
          row.ciphertext,
          `integration-provider:user:${userId}:${provider}:${row.revision}`,
        ),
      ),
    );
    if (config.provider !== provider) throw new Error("Integration configuration does not match");
    return {
      provider: this.create(config),
      recheck: async (client: Client) => {
        const current = await read(
          (query) => query.userIntegrationProviderConfig.findUnique({ where }),
          client,
        );
        return current?.revision === row.revision && current.ciphertext === row.ciphertext;
      },
    };
  }

  async prepareSave(
    config: IntegrationProviderConfig,
    context: AdapterContext,
  ): Promise<{ id: string; ciphertext: string; store: (client: Client) => Promise<void> }> {
    if (!context.userId) throw new Error("A personal account is required");
    const parsed = IntegrationProviderConfigSchema.safeParse(config);
    if (!parsed.success || ("apiKey" in parsed.data && !parsed.data.apiKey.trim())) {
      throw new Error("Invalid integration credentials");
    }
    config = parsed.data;
    try {
      await this.create(config).listConnectedExternalIds(context);
    } catch (error) {
      throw credentialVerificationError(error);
    }
    const revision = randomUUID();
    const stored = await this.secrets.put(JSON.stringify(config), context, {
      recordId: `integration-provider:user:${context.userId}:${config.provider}:${revision}`,
    });
    return {
      ...stored,
      store: async (client: Client) => {
        await client.userIntegrationProviderConfig.upsert({
          where: { userId_provider: { userId: context.userId, provider: config.provider } },
          create: {
            userId: context.userId,
            provider: config.provider,
            revision,
            ciphertext: stored.ciphertext,
          },
          update: { ciphertext: stored.ciphertext, revision },
        });
      },
    };
  }

  async save(config: IntegrationProviderConfig, context: AdapterContext): Promise<void> {
    const prepared = await this.prepareSave(config, context);
    await prepared.store(this.prisma);
  }

  async revoke(
    userId: string,
    provider: IntegrationProviderId,
    client: Client = this.prisma,
  ): Promise<void> {
    if (!userId) throw new Error("A personal account is required");
    await client.userIntegrationProviderConfig.deleteMany({ where: { userId, provider } });
  }
}
