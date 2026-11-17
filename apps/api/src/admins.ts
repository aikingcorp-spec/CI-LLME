import { ORPCError } from "@orpc/server";
import { machineOwnerUserId } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type AdminDeps = Pick<RouterDeps, "prisma"> & { env: Pick<RouterDeps["env"], "adminEmails"> };
export type LocalMcpAdminDeps = AdminDeps &
  Partial<Pick<RouterDeps, "billing" | "issueRemoteEnter" | "remoteAccess">>;

export function isHostedCentralPortal(
  deps: Partial<Pick<RouterDeps, "billing" | "issueRemoteEnter" | "remoteAccess">>,
): boolean {
  return Boolean(deps.billing || deps.issueRemoteEnter || deps.remoteAccess);
}

/** Accounts listed in RAKAZO_ADMIN_EMAILS, once their email is verified. */
export async function isAdmin(deps: AdminDeps, userId: string): Promise<boolean> {
  const admins = deps.env.adminEmails ?? [];
  if (admins.length === 0) return false;
  const user = await deps.prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  return Boolean(user?.emailVerified && admins.includes(user.email.toLowerCase()));
}

/**
 * Local MCP stdio servers run on this node's OS process. Explicit RAKAZO_ADMIN_EMAILS win;
 * on a Desktop or self-hosted node with no admin email list configured, the local machine
 * owner (first local user) may also manage local MCP stdio servers.
 */
export async function isLocalMcpAdmin(deps: LocalMcpAdminDeps, userId: string): Promise<boolean> {
  if (await isAdmin(deps, userId)) return true;
  if (isHostedCentralPortal(deps)) return false;
  if ((deps.env.adminEmails?.length ?? 0) > 0) return false;
  if (!deps.prisma.user?.findFirst) return false;
  return (await machineOwnerUserId(deps.prisma)) === userId;
}

export async function requireAdmin(deps: AdminDeps, userId: string): Promise<void> {
  if (!(await isAdmin(deps, userId))) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
}
