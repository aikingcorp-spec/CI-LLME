import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

/**
 * The account that owns this install: the first account that verified its email here.
 * Owner and invited people are all ordinary users, so this never reads Space roles.
 */
export async function machineOwnerUserId(
  prisma: Pick<PrismaClient, "user">,
): Promise<string | null> {
  const owner = await runAsSystem("find the account that owns this install", () =>
    prisma.user.findFirst({
      where: { emailVerified: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }),
  );
  return owner?.id ?? null;
}
