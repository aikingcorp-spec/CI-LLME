import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  hasModelAccess,
  memberHasModelAccess,
  organizationForMember,
  ownerHadTrial,
} from "./billing.js";
import { PrismaClient } from "./client.js";
import { homeOrganizationId } from "./spaces.js";

describe("model access", () => {
  const now = new Date("2030-01-15T12:00:00.000Z");
  const later = new Date("2030-02-14T12:00:00.000Z");
  it.each([
    { mode: null, balanceMicros: 0n, byokFreeUntil: null, status: null, access: false },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: later, status: null, access: true },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: now, status: null, access: false },
    { mode: "byok", balanceMicros: 0n, byokFreeUntil: null, status: "active", access: true },
    // A top-up does not pay for running your own key.
    { mode: "byok", balanceMicros: 5n, byokFreeUntil: null, status: null, access: false },
    { mode: "credits", balanceMicros: 5n, byokFreeUntil: null, status: null, access: true },
    { mode: null, balanceMicros: 5n, byokFreeUntil: null, status: null, access: true },
    // Spent credits do not leave own-key runs on other providers free.
    { mode: "credits", balanceMicros: 0n, byokFreeUntil: null, status: null, access: false },
    { mode: "credits", balanceMicros: 0n, byokFreeUntil: null, status: "canceled", access: false },
  ])("$mode with balance $balanceMicros and $status: $access", ({ status, access, ...credits }) => {
    expect(hasModelAccess(credits, status, now)).toBe(access);
  });
});

describe("one trial per person", () => {
  function prisma(usedAt: Date | null) {
    const findFirst = vi.fn().mockResolvedValue(null);
    const client = {
      user: { findUnique: vi.fn().mockResolvedValue({ billingTrialUsedAt: usedAt }) },
      member: { findFirst },
    } as unknown as PrismaClient;
    return { client, findFirst };
  }

  it("counts free own-key days against the own-key trial only", async () => {
    const { client, findFirst } = prisma(null);
    await ownerHadTrial(client, "user-1", "byok");
    await ownerHadTrial(client, "user-1", "managed");
    const [byok, managed] = findFirst.mock.calls.map(([query]) => query.where.organization);
    expect(JSON.stringify(byok)).toContain("byokFreeUntil");
    expect(JSON.stringify(managed)).not.toContain("byokFreeUntil");
    expect(JSON.stringify(managed)).toContain("subscribedAt");
  });

  it("treats the user-level mark as a used trial for either plan", async () => {
    const { client, findFirst } = prisma(new Date());
    await expect(ownerHadTrial(client, "user-1", "managed")).resolves.toBe(true);
    await expect(ownerHadTrial(client, "user-1", "byok")).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

it("looks up the membership by space and user alone when given a whole run", async () => {
  const findUnique = vi.fn().mockResolvedValue(null);
  const client = { spaceMember: { findUnique } } as unknown as PrismaClient;
  const run = { id: "run-1", botId: "bot-1", spaceId: "space-1", userId: "user-1" };
  await memberHasModelAccess(client, run);
  expect(findUnique.mock.calls[0]?.[0].where).toEqual({
    spaceId_userId: { spaceId: "space-1", userId: "user-1" },
  });
});

it("denies model access to an unpaid member without consulting another organization", async () => {
  const findUnique = vi.fn().mockResolvedValue({
    member: {
      role: "member",
      organization: { modelCredits: null, billing: null },
    },
  });
  const organizationLookup = vi.fn();
  const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  vi.spyOn(client.spaceMember, "findUnique").mockImplementation(findUnique);
  vi.spyOn(client.organization, "findUnique").mockImplementation(organizationLookup);
  try {
    await expect(
      memberHasModelAccess(client, { spaceId: "space-1", userId: "user-1" }),
    ).resolves.toBe(false);
    expect(organizationLookup).not.toHaveBeenCalled();
  } finally {
    await client.$disconnect();
    await pool.end();
  }
});

describe("a guest-only visitor on a remote computer", () => {
  const hostOrganization = { id: "host-org", modelCredits: null, billing: null };

  it("works with the inviting owner's models, never looking for an organization of their own", async () => {
    const organizationLookup = vi.fn();
    const client = {
      spaceMember: {
        findUnique: vi.fn().mockResolvedValue({
          member: { role: "guest", organization: hostOrganization },
        }),
      },
      member: {
        findMany: vi.fn().mockResolvedValue([{ organizationId: "host-org", role: "guest" }]),
      },
      organization: { findUnique: organizationLookup },
    } as unknown as PrismaClient;
    await expect(
      memberHasModelAccess(client, { spaceId: "space-1", userId: "visitor" }),
    ).resolves.toBe(false);
    expect(organizationLookup).not.toHaveBeenCalled();
  });

  it("keeps a guest with an organization of their own on their own models", async () => {
    const organizationLookup = vi.fn().mockResolvedValue({ modelCredits: null, billing: null });
    const client = {
      spaceMember: {
        findUnique: vi.fn().mockResolvedValue({
          member: { role: "guest", organization: hostOrganization },
        }),
      },
      member: {
        findMany: vi.fn().mockResolvedValue([{ organizationId: "own-org", role: "owner" }]),
      },
      organization: { findUnique: organizationLookup },
    } as unknown as PrismaClient;
    await memberHasModelAccess(client, { spaceId: "space-1", userId: "guest" });
    expect(organizationLookup.mock.calls[0]?.[0].where).toEqual({ id: "own-org" });
  });

  it("bills the inviting owner's organization without making the visitor its owner", async () => {
    const client = {
      space: { findUnique: vi.fn().mockResolvedValue({ organizationId: "host-org" }) },
      member: {
        findUnique: vi.fn().mockResolvedValue({ role: "guest" }),
        findMany: vi.fn().mockResolvedValue([{ organizationId: "host-org", role: "guest" }]),
      },
    } as unknown as PrismaClient;
    await expect(
      organizationForMember(client, { spaceId: "space-1", userId: "visitor" }),
    ).resolves.toEqual({ organizationId: "host-org", isOwner: false });
  });

  it("lists the Spaces it was invited to through the shared Space's organization", async () => {
    const client = {
      spaceMember: {
        findUnique: vi.fn().mockResolvedValue({
          organizationId: "host-org",
          member: { role: "guest" },
        }),
      },
      member: {
        findMany: vi.fn().mockResolvedValue([{ organizationId: "host-org", role: "guest" }]),
      },
    } as unknown as PrismaClient;
    await expect(
      homeOrganizationId(client, { userId: "visitor", spaceId: "space-1" }),
    ).resolves.toBe("host-org");
  });
});
