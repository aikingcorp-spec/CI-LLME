import path from "node:path";
import {
  EncryptedSecretStore,
  legacyNativeBaselineTransform,
  migrateJobQueue,
  restoreLegacyNativeExtras,
  verifyLegacyNativeData,
} from "@rakazo/adapters";
import {
  createDb,
  databaseUrls,
  deployMigrations,
  importLegacyNativeDatabase,
  LocalKeyProvider,
  legacyNativeImportState,
  markLegacyNativeImportVerified,
  masterKeysFromEnv,
  prepareLegacyMigrationBaseline,
  provisionRuntimeRole,
} from "@rakazo/db";

async function main() {
  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  const sourceDigest = process.env.LEGACY_SOURCE_DIGEST;
  const encryptionKey = process.env.ENCRYPTION_KEY;
  const dbPackageDir = process.env.RAKAZO_DB_PACKAGE_DIR;
  const baselineDir = process.env.LEGACY_BASELINE_DIR;
  if (!legacyUrl || !sourceDigest || !encryptionKey || !dbPackageDir || !baselineDir)
    throw new Error("Native import configuration is missing.");
  const urls = databaseUrls(process.env);
  const sourceEndpoint = new URL(legacyUrl),
    targetEndpoint = new URL(urls.migrationUrl);
  for (const url of [sourceEndpoint, targetEndpoint])
    if (url.hostname !== "127.0.0.1") throw new Error("Native import requires loopback databases.");
  if (
    sourceEndpoint.host === targetEndpoint.host &&
    sourceEndpoint.pathname === targetEndpoint.pathname
  )
    throw new Error("Native import requires separate databases.");
  const signal = AbortSignal.timeout(30 * 60 * 1000);
  const source = createDb(legacyUrl, { encryptContent: false });
  const destination = createDb(urls.migrationUrl, {
    encryptContent: true,
    keyProvider: new LocalKeyProvider(masterKeysFromEnv(process.env)),
  });
  try {
    const sourceClient = await source.pool.connect();
    try {
      const targetClient = await destination.pool.connect();
      try {
        const secrets = new EncryptedSecretStore(encryptionKey);
        const state = await legacyNativeImportState(sourceClient, targetClient, sourceDigest);
        if (state === "empty") {
          const directory = await prepareLegacyMigrationBaseline({
            source: sourceClient,
            currentMigrations: path.join(dbPackageDir, "prisma", "migrations"),
            destination: baselineDir,
          });
          await deployMigrations({
            migrationUrl: urls.migrationUrl,
            dbPackageDir,
            migrationsDir: directory,
          });
          await importLegacyNativeDatabase({
            source: sourceClient,
            destination: targetClient,
            sourceDigest,
            signal,
            transform: legacyNativeBaselineTransform,
          });
        }
        if (state !== "verified") {
          await deployMigrations({ migrationUrl: urls.migrationUrl, dbPackageDir });
          await restoreLegacyNativeExtras(sourceClient, destination, secrets, signal);
          await verifyLegacyNativeData(destination, secrets, signal);
          await migrateJobQueue(urls.migrationUrl);
          if (urls.separate) await provisionRuntimeRole(urls.migrationUrl, urls.url);
          await markLegacyNativeImportVerified(targetClient, sourceDigest);
        } else {
          await verifyLegacyNativeData(destination, secrets, signal);
        }
        process.stdout.write("Legacy import verified.\n");
      } finally {
        targetClient.release();
      }
    } finally {
      sourceClient.release();
    }
  } finally {
    await Promise.all([source.prisma.$disconnect(), destination.prisma.$disconnect()]);
    await Promise.all([source.pool.end(), destination.pool.end()]);
  }
}
try {
  await main();
} catch {
  process.stderr.write("Legacy import was refused. Original data was kept.\n");
  process.exitCode = 1;
}
