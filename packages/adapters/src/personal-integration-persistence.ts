import { Prisma } from "@rakazo/db";

export function personalIntegrationRecordId(userId: string, provider: string, revision: string) {
  return `integration-provider:user:${userId}:${provider}:${revision}`;
}

export function personalIntegrationKey(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "userId" in value &&
    typeof value.userId === "string" &&
    "provider" in value &&
    typeof value.provider === "string"
  )
    return { userId: value.userId, provider: value.provider };
  return undefined;
}

/** Capture the revision and reference together under the same lock as replacement or removal. */
export async function lockPersonalIntegrationRefs(
  tx: Prisma.TransactionClient,
  where: Record<string, unknown> = {},
  upsert = false,
) {
  const { userId_provider, ...filter } = where;
  const key = personalIntegrationKey(userId_provider);
  if (upsert && key) {
    // Two first saves can both see a missing row. Lock its existing owner before checking.
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${key.userId} FOR NO KEY UPDATE`;
  }
  const keys = await tx.userIntegrationProviderConfig.findMany({
    where: key ? { ...filter, ...key } : where,
    select: { userId: true, provider: true },
  });
  if (!keys.length) return [];
  const pairs = keys.map(({ userId, provider }) => Prisma.sql`(${userId}, ${provider})`);
  const rows = await tx.$queryRaw<
    { userId: string; provider: string; revision: string; ciphertext: string }[]
  >`SELECT "userId", provider, revision, ciphertext FROM user_integration_provider_configs
    WHERE ("userId", provider) IN (${Prisma.join(pairs)}) ORDER BY "userId", provider FOR UPDATE`;
  return rows.map((row) => ({
    id: personalIntegrationRecordId(row.userId, row.provider, row.revision),
    ciphertext: row.ciphertext,
  }));
}
