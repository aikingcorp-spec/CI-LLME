import type { PrismaClient } from "./client.js";
import { GUEST_ROLE } from "./guest-role.js";

type SpaceMemberReader = Pick<PrismaClient, "spaceMember">;
type OwnerReader = Pick<PrismaClient, "space" | "member">;

/**
 * The acting user's role in a Space, read from `space_members` at the time of the action.
 * Never take a role or Space id from the client instead.
 */
export async function spaceMemberRole(
  prisma: SpaceMemberReader,
  scope: { spaceId: string; userId: string },
): Promise<string | null> {
  const row = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: scope.spaceId, userId: scope.userId } },
    select: { role: true },
  });
  return row?.role ?? null;
}

/** No memberships is a local account. A guest-only account has nothing but guest roles. */
export function isGuestOnlyMembership(roles: readonly string[]): boolean {
  if (roles.length === 0) return false;
  return roles.every((role) => {
    const parts = roleParts(role);
    return parts.length > 0 && parts.every((part) => part === GUEST_ROLE);
  });
}

export async function isSpaceGuest(
  prisma: SpaceMemberReader,
  scope: { spaceId: string; userId: string },
): Promise<boolean> {
  return (await spaceMemberRole(prisma, scope)) === GUEST_ROLE;
}

/** A host-Space guest asked to change something only the Space's own members may change. */
export class GuestForbiddenError extends Error {
  constructor() {
    super("Space guests cannot change this setting");
    this.name = "GuestForbiddenError";
  }
}

export async function assertNotSpaceGuest(
  prisma: SpaceMemberReader,
  scope: { spaceId: string; userId: string },
): Promise<void> {
  if (await isSpaceGuest(prisma, scope)) throw new GuestForbiddenError();
}

function roleParts(role: string | null | undefined): string[] {
  return (role ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Whether the actor owns the organization of this Space. On a node, that person is the Host.
 * Only the owner may use the Host's own computer. An admin manages the workspace and is not
 * the machine owner. A guest is never the owner, even if a combined role string names both.
 */
export async function isSpaceOrganizationOwner(
  prisma: OwnerReader,
  scope: { spaceId: string; userId: string },
): Promise<boolean> {
  const space = await prisma.space.findUnique({
    where: { id: scope.spaceId },
    select: { organizationId: true },
  });
  if (!space) return false;
  const member = await prisma.member.findUnique({
    where: {
      organizationId_userId: { organizationId: space.organizationId, userId: scope.userId },
    },
    select: { role: true },
  });
  const roles = roleParts(member?.role);
  return roles.includes("owner") && !roles.includes(GUEST_ROLE);
}

/**
 * Desktop kind is the Host machine. A deployment that points the computer at this machine
 * still stays on the configured sandbox unless the actor owns the Space's organization.
 */
export function computerKindForActor(input: {
  envKind: string;
  computerHost: string | null | undefined;
  organizationOwner: boolean;
}): string {
  return input.envKind === "docker" && input.computerHost === "this-mac" && input.organizationOwner
    ? "desktop"
    : input.envKind;
}
