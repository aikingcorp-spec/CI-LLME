import type { PrismaClient } from "@rakazo/db";
import { isGuestOnlyMembership } from "@rakazo/db";

/**
 * Keeps the local computer present while the host process is up.
 * A closed window does not stop it. Sign-out does: with no session, or with
 * more than one non-guest account and no account named by this process, it
 * does not guess. A guest session never becomes this computer's account.
 */
export function startLocalPresence(input: {
  intervalMs: number;
  /** Report once as soon as the process starts, before the first interval. */
  leading?: boolean;
  signedInAccount: () => Promise<string | null>;
  accountStillSignedIn: (accountId: string) => Promise<boolean>;
  present: (accountId: string) => Promise<unknown>;
  /** The signed-in account is gone, so a running connector must stop. */
  onSignedOut?: () => void;
  onError?: (error: unknown) => void;
}): { note(accountId: string): void; stop(): Promise<void> } {
  let noted: string | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    running ??= (async () => {
      if (noted && !(await input.accountStillSignedIn(noted))) {
        noted = undefined;
        input.onSignedOut?.();
      }
      if (!noted) noted = (await input.signedInAccount()) ?? undefined;
      if (noted) await input.present(noted);
    })()
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        running = undefined;
      });
  };

  const timer = setInterval(tick, input.intervalMs);
  timer.unref?.();
  if (input.leading) tick();

  return {
    note(accountId: string) {
      noted = accountId;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

/**
 * The host account for this computer. Guest sessions never count.
 * Two non-guest accounts are not guessed.
 */
export function hostRemoteAccount(
  signedIn: readonly { userId: string; guestOnly: boolean }[],
): string | null {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const row of signedIn) {
    if (row.guestOnly || seen.has(row.userId)) continue;
    seen.add(row.userId);
    hosts.push(row.userId);
  }
  const accountId = hosts[0];
  return hosts.length === 1 && accountId ? accountId : null;
}

/** The only non-guest signed-in account, or null when nobody or more than one host is signed in. */
export async function soleSignedInAccount(prisma: PrismaClient, now = new Date()) {
  const rows = await prisma.session.findMany({
    where: { expiresAt: { gt: now } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const userIds = [...new Set(rows.map((row) => row.userId))];
  if (userIds.length === 0) return null;
  const memberships = await prisma.member.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, role: true },
  });
  const roles = new Map<string, string[]>();
  for (const row of memberships) {
    const list = roles.get(row.userId) ?? [];
    list.push(row.role);
    roles.set(row.userId, list);
  }
  return hostRemoteAccount(
    userIds.map((userId) => ({
      userId,
      guestOnly: isGuestOnlyMembership(roles.get(userId) ?? []),
    })),
  );
}

export async function isGuestOnlyUser(prisma: PrismaClient, userId: string) {
  const memberships = await prisma.member.findMany({
    where: { userId },
    select: { role: true },
  });
  return isGuestOnlyMembership(memberships.map((row) => row.role));
}

export async function accountHasSession(prisma: PrismaClient, accountId: string, now = new Date()) {
  const row = await prisma.session.findFirst({
    where: { userId: accountId, expiresAt: { gt: now } },
    select: { id: true },
  });
  return row !== null;
}
