// One bundled entry also hosts the isolated migration utility process.
if (process.argv.includes("--rakazo-native-migrate")) {
  const { migrateNativeDatabase, migrateNativeJobQueue, provisionNativeRuntimeRole } = await import(
    "./native-migrate.js"
  );
  try {
    await migrateNativeDatabase({
      databaseUrl: process.env.DATABASE_MIGRATION_URL!,
      dbDir: process.env.RAKAZO_NATIVE_DB_DIR!,
      migrationsDir: process.env.RAKAZO_NATIVE_MIGRATIONS_DIR!,
    });
    await migrateNativeJobQueue(
      process.env.DATABASE_MIGRATION_URL!,
      process.env.RAKAZO_NATIVE_DB_DIR!,
    );
    await provisionNativeRuntimeRole(
      process.env.DATABASE_MIGRATION_URL!,
      process.env.RAKAZO_NATIVE_RUNTIME_URL!,
      process.env.RAKAZO_NATIVE_DB_DIR!,
    );
    process.exit(0);
  } catch {
    process.exit(1);
  }
} else {
  await import("./main-app.js");
}

export {};
