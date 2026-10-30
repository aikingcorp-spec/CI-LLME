import { contentKeyProviderFromEnv } from "@rakazo/adapters";
import { parseEmailAllowlistArgs, runEmailAllowlist } from "@rakazo/auth";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, runAsSystem } from "@rakazo/db";

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const command = parseEmailAllowlistArgs(process.argv.slice(2));
const { prisma, pool } = createDb(databaseUrl, {
  applicationName: "rakazo-email-allowlist",
  keyProvider: contentKeyProviderFromEnv(),
});
try {
  const text = await runAsSystem("edit the sign-in invite list", () =>
    runEmailAllowlist(prisma, command),
  );
  process.stdout.write(text);
} finally {
  await prisma.$disconnect();
  await pool.end();
}
