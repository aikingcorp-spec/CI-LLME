import type { PrismaClient } from "./client.js";
import { currentDbContext, runAsSystem, runAsSystemInTransaction } from "./row-security.js";

function hasQueryRaw(client: unknown): client is Pick<PrismaClient, "$queryRaw"> {
  return Boolean(
    client &&
      typeof client === "object" &&
      "$queryRaw" in client &&
      typeof (client as { $queryRaw?: unknown }).$queryRaw === "function",
  );
}

function isRootPrismaClient(client: unknown): boolean {
  return Boolean(
    client &&
      typeof client === "object" &&
      "$transaction" in client &&
      typeof (client as { $transaction?: unknown }).$transaction === "function",
  );
}

/**
 * Runs a Space Owner credential lookup or OAuth refresh safely across RLS boundaries:
 * - Outside a tenant context (system jobs or unit-test mocks), runs directly.
 * - Inside an open interactive transaction `tx`, temporarily elevates that connection
 *   without checking out a second pool connection.
 * - On a root PrismaClient, runs under `runAsSystem`.
 */
export function runWithSystemBypass<T>(
  client: unknown,
  reason: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (currentDbContext()?.kind !== "tenant") {
    return fn();
  }
  if (!isRootPrismaClient(client) && hasQueryRaw(client)) {
    return runAsSystemInTransaction(client, reason, fn);
  }
  return runAsSystem(reason, fn);
}

/**
 * Authoritative Space Owner lookup via `space_members.role = "owner"`.
 * Safe when called with partial unit-test Prisma mocks that omit `spaceMember`.
 */
export async function spaceOwnerUserId(
  prisma: Partial<Pick<PrismaClient, "spaceMember">> | undefined,
  spaceId: string | null | undefined,
): Promise<string | null> {
  if (!spaceId || !prisma?.spaceMember?.findFirst) return null;
  const owner = await prisma.spaceMember.findFirst({
    where: { spaceId, role: "owner" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { userId: true },
  });
  return owner?.userId ?? null;
}

/**
 * Resolves a value for `scope.userId` first; when empty (`isMissing(own)`) and `scope.userId`
 * is not the Space Owner, falls back to the Space Owner's scope in the same Space under RLS bypass.
 */
export async function resolveWithSpaceOwnerFallback<
  S extends { userId: string; spaceId: string },
  T,
>(
  prisma: Partial<Pick<PrismaClient, "spaceMember">> | undefined,
  scope: S,
  reason: string,
  read: (effectiveScope: S, borrowed: boolean) => Promise<T>,
  isMissing: (value: T) => boolean = (value) => value === null || value === undefined,
): Promise<{ value: T; effectiveUserId: string; borrowed: boolean }> {
  const own = await read(scope, false);
  if (!isMissing(own)) {
    return { value: own, effectiveUserId: scope.userId, borrowed: false };
  }
  const ownerId = await spaceOwnerUserId(prisma, scope.spaceId);
  if (!ownerId || ownerId === scope.userId) {
    return { value: own, effectiveUserId: scope.userId, borrowed: false };
  }
  const ownerScope = { ...scope, userId: ownerId };
  const borrowedValue = await runWithSystemBypass(prisma, reason, () => read(ownerScope, true));
  if (isMissing(borrowedValue)) {
    return { value: own, effectiveUserId: scope.userId, borrowed: false };
  }
  return { value: borrowedValue, effectiveUserId: ownerId, borrowed: true };
}
