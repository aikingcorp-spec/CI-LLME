import type { PrismaClient } from "@rakazo/db";
import { acceptSpaceInvite, runAsSystem, spaceInviteIsOpen } from "@rakazo/db";

/**
 * A central subject gets a host session only as themselves.
 * An existing space member, including the computer's owner, is admitted.
 * Someone with no membership is admitted only after the existing invite link
 * adds them as a guest. A ticket alone does not create a user or an owner.
 */
export async function admitRemoteVisitor(
  db: PrismaClient,
  input: {
    accountId: string;
    email?: string;
    inviteToken?: string;
    createUser: (email: string) => Promise<string | null>;
  },
): Promise<string | null> {
  const existing = await runAsSystem("resolve a remote visitor", async () => {
    const account = await db.account.findFirst({
      where: { providerId: "verified-identity", accountId: input.accountId },
      select: { userId: true },
    });
    if (!account) return null;
    const member = await db.spaceMember.findFirst({
      where: { userId: account.userId },
      select: { id: true },
    });
    if (member) return account.userId;
    if (!input.inviteToken || !(await spaceInviteIsOpen(db, input.inviteToken))) return null;
    await acceptSpaceInvite(db, { token: input.inviteToken, userId: account.userId });
    return account.userId;
  });
  if (existing) return existing;
  if (!input.inviteToken || !input.email) return null;
  const open = await runAsSystem("check a remote invite", () =>
    spaceInviteIsOpen(db, input.inviteToken as string),
  );
  if (!open) return null;
  const userId = await input.createUser(input.email);
  if (!userId) return null;
  try {
    await runAsSystem("accept a remote invite", () =>
      acceptSpaceInvite(db, { token: input.inviteToken as string, userId }),
    );
  } catch {
    return null;
  }
  return userId;
}
