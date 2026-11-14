import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "./client.js";
import {
  assertNotSpaceGuest,
  computerKindForActor,
  GuestForbiddenError,
  isGuestOnlyMembership,
  isSpaceGuest,
  isSpaceOrganizationOwner,
} from "./guest-access.js";
import { GUEST_ROLE } from "./guest-role.js";

const scope = { spaceId: "space-1", userId: "user-1" };

// No query reaches Postgres. Keep the real delegates so the compiler checks the boundary.
const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.$disconnect();
  await pool.end();
});

function spaceMembers(role: string | null) {
  vi.spyOn(prisma.spaceMember, "findUnique").mockImplementation(
    vi.fn().mockResolvedValue(role === null ? null : { role }),
  );
  return prisma;
}

describe("space guest access", () => {
  it("treats an account as guest-only only when every role is guest", () => {
    expect(isGuestOnlyMembership([])).toBe(false);
    expect(isGuestOnlyMembership([GUEST_ROLE])).toBe(true);
    expect(isGuestOnlyMembership([GUEST_ROLE, GUEST_ROLE])).toBe(true);
    expect(isGuestOnlyMembership(["owner"])).toBe(false);
    expect(isGuestOnlyMembership([GUEST_ROLE, "owner"])).toBe(false);
    expect(isGuestOnlyMembership([`owner,${GUEST_ROLE}`])).toBe(false);
  });

  it("treats only the guest space role as a guest", async () => {
    expect(await isSpaceGuest(spaceMembers(GUEST_ROLE), scope)).toBe(true);
    expect(await isSpaceGuest(spaceMembers("member"), scope)).toBe(false);
    expect(await isSpaceGuest(spaceMembers("owner"), scope)).toBe(false);
    expect(await isSpaceGuest(spaceMembers(null), scope)).toBe(false);
  });

  it("rejects a guest write and allows a member write", async () => {
    await expect(assertNotSpaceGuest(spaceMembers(GUEST_ROLE), scope)).rejects.toBeInstanceOf(
      GuestForbiddenError,
    );
    await expect(assertNotSpaceGuest(spaceMembers("owner"), scope)).resolves.toBeUndefined();
  });

  it("gives the host computer only to an organization owner who is not a guest", async () => {
    const readers = (memberRole: string | null, space = true) => {
      vi.spyOn(prisma.space, "findUnique").mockImplementation(
        vi.fn().mockResolvedValue(space ? { organizationId: "org-1" } : null),
      );
      vi.spyOn(prisma.member, "findUnique").mockImplementation(
        vi.fn().mockResolvedValue(memberRole === null ? null : { role: memberRole }),
      );
      return prisma;
    };
    expect(await isSpaceOrganizationOwner(readers("owner"), scope)).toBe(true);
    expect(await isSpaceOrganizationOwner(readers("owner,admin"), scope)).toBe(true);
    expect(await isSpaceOrganizationOwner(readers(`owner,${GUEST_ROLE}`), scope)).toBe(false);
    expect(await isSpaceOrganizationOwner(readers("admin"), scope)).toBe(false);
    expect(await isSpaceOrganizationOwner(readers(GUEST_ROLE), scope)).toBe(false);
    expect(await isSpaceOrganizationOwner(readers("owner", false), scope)).toBe(false);
  });

  it("keeps a non-owner on the sandbox when the deployment offers this machine", () => {
    expect(
      computerKindForActor({
        envKind: "docker",
        computerHost: "this-mac",
        organizationOwner: true,
      }),
    ).toBe("desktop");
    expect(
      computerKindForActor({
        envKind: "docker",
        computerHost: "this-mac",
        organizationOwner: false,
      }),
    ).toBe("docker");
    expect(
      computerKindForActor({ envKind: "local", computerHost: "this-mac", organizationOwner: true }),
    ).toBe("local");
    expect(
      computerKindForActor({ envKind: "docker", computerHost: "cloud", organizationOwner: true }),
    ).toBe("docker");
  });
});
