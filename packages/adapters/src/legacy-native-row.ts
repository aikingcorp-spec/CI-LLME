import type { SecretStore } from "@rakazo/adapter-kit";
import {
  AppLocaleSchema,
  IntegrationProviderConfigSchema,
  IntegrationProviderIdSchema,
} from "@rakazo/contracts";
import type { createDb, LegacyMigrationClient, LegacyNativeRowTransform } from "@rakazo/db";
import { contentEncryptionOf, ENCRYPTED_MODELS, runAsSystem } from "@rakazo/db";
import { personalIntegrationRecordId } from "./personal-integration-persistence.js";
import { importLegacyPersonalIntegration } from "./personal-integration-settings.js";

/** Keep upstream columns until its migrations transform them. VNBot-only values are restored later. */
export const legacyNativeBaselineTransform: LegacyNativeRowTransform = async (table, original) => {
  if (table === "auth_email_allowlist" || table === "user_integration_provider_configs")
    return null;
  const row = { ...original };
  if (table === "user") {
    delete row.uiLocale;
    delete row.taskContinuityEnabled;
  }
  if (table === "messages") delete row.authorUserId;
  if (table === "runs") delete row.webhookSourceId;
  return row;
};

export async function restoreLegacyNativeExtras(
  source: LegacyMigrationClient,
  database: ReturnType<typeof createDb>,
  secrets: SecretStore,
  signal: AbortSignal,
): Promise<void> {
  const hasColumn = async (table: string, column: string) =>
    Boolean(
      (
        await source.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
          [table, column],
        )
      ).rowCount,
    );
  await runAsSystem("restore copied native preferences", async () => {
    if (await hasColumn("user", "uiLocale")) {
      let cursor = "";
      for (;;) {
        signal.throwIfAborted();
        const rows = (
          await source.query<{ id: string; uiLocale: string }>(
            'SELECT id,"uiLocale" FROM "user" WHERE id>$1 AND "uiLocale" IS NOT NULL ORDER BY id LIMIT 128',
            [cursor],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows)
          await database.prisma.user.update({
            where: { id: row.id },
            data: { locale: AppLocaleSchema.parse(row.uiLocale) },
          });
        cursor = rows.at(-1)!.id;
      }
    }
    if (await hasColumn("messages", "authorUserId")) {
      let cursor = "";
      for (;;) {
        signal.throwIfAborted();
        const rows = (
          await source.query<{ id: string; authorUserId: string }>(
            'SELECT id,"authorUserId" FROM messages WHERE id>$1 AND "authorUserId" IS NOT NULL ORDER BY id LIMIT 128',
            [cursor],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows)
          await database.prisma.message.update({
            where: { id: row.id },
            data: { authorUserId: row.authorUserId },
          });
        cursor = rows.at(-1)!.id;
      }
    }
    if (await hasColumn("user_integration_provider_configs", "revision")) {
      let userId = "",
        provider = "";
      for (;;) {
        signal.throwIfAborted();
        const rows = (
          await source.query<{
            userId: string;
            provider: string;
            ciphertext: string;
            revision: number;
            updatedAt: Date;
          }>(
            'SELECT * FROM user_integration_provider_configs WHERE "userId">$1 OR ("userId"=$1 AND provider>$2) ORDER BY "userId",provider LIMIT 128',
            [userId, provider],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) {
          const parsedProvider = IntegrationProviderIdSchema.parse(row.provider);
          const result = await importLegacyPersonalIntegration(
            database.prisma,
            { ...row, provider: parsedProvider },
            secrets,
            secrets,
            {
              userId: row.userId,
              spaceId: "",
              operationId: "native-legacy-import",
              traceId: "native-legacy-import",
              signal,
            },
          );
          if (result === "imported")
            await database.prisma.userIntegrationProviderConfig.update({
              where: { userId_provider: { userId: row.userId, provider: parsedProvider } },
              data: { updatedAt: row.updatedAt },
            });
        }
        userId = rows.at(-1)!.userId;
        provider = rows.at(-1)!.provider;
      }
    }
  });
}

/** Reads every supported encrypted field and secret without emitting or rewriting plaintext. */
export async function verifyLegacyNativeData(
  database: ReturnType<typeof createDb>,
  secrets: SecretStore,
  signal: AbortSignal,
): Promise<void> {
  await runAsSystem("verify copied native content", async () => {
    const encryption = contentEncryptionOf(database.prisma);
    if (!encryption) throw new Error("Native import verification needs an encrypting client.");
    for (const [model, spec] of Object.entries(ENCRYPTED_MODELS)) {
      let cursor = "";
      for (;;) {
        signal.throwIfAborted();
        const table = `"${spec.table.replaceAll('"', '""')}"`;
        const rows = (
          await database.pool.query(`SELECT * FROM ${table} WHERE id>$1 ORDER BY id LIMIT 128`, [
            cursor,
          ])
        ).rows;
        if (!rows.length) break;
        await encryption.openRows(model, rows);
        cursor = rows.at(-1).id;
      }
    }
    async function verifySecrets(
      load: (cursor: string) => Promise<Array<{ id: string; ciphertext: string }>>,
    ) {
      let cursor = "";
      for (;;) {
        signal.throwIfAborted();
        const rows = await load(cursor);
        if (!rows.length) return;
        for (const row of rows) await secrets.load(row.ciphertext, { recordId: row.id, signal });
        cursor = rows.at(-1)!.id;
      }
    }
    await verifySecrets((cursor) =>
      database.prisma.secret.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: 128,
        select: { id: true, ciphertext: true },
      }),
    );
    await verifySecrets((cursor) =>
      database.prisma.vaultCredential.findMany({
        where: { id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: 128,
        select: { id: true, ciphertext: true },
      }),
    );
    let userId = "",
      provider = "";
    for (;;) {
      signal.throwIfAborted();
      const rows = await database.prisma.userIntegrationProviderConfig.findMany({
        where: { OR: [{ userId: { gt: userId } }, { userId, provider: { gt: provider } }] },
        orderBy: [{ userId: "asc" }, { provider: "asc" }],
        take: 128,
      });
      if (!rows.length) break;
      for (const row of rows) {
        const plaintext = await secrets.load(row.ciphertext, {
          recordId: personalIntegrationRecordId(row.userId, row.provider, row.revision),
          signal,
        });
        if (IntegrationProviderConfigSchema.parse(JSON.parse(plaintext)).provider !== row.provider)
          throw new Error("Imported integration owner does not match.");
      }
      userId = rows.at(-1)!.userId;
      provider = rows.at(-1)!.provider;
    }
  });
}
