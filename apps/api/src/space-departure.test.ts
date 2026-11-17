import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, SpaceDeparture, ThreadEvents } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { afterSpaceDeparture } from "./space-departure.js";

const emptyDeparture: SpaceDeparture = {
  events: [],
  cancelledRunIds: [],
  heldControls: [],
  continuationRunIds: [],
  computers: [],
};

function makeDeps(input: {
  remainingSpaces: number;
  scope: string | null;
  revokeMember: (memberAccountId: string) => Promise<unknown>;
}) {
  return {
    prisma: {
      spaceMember: { count: async () => input.remainingSpaces },
      account: { findFirst: async () => (input.scope ? { scope: input.scope } : null) },
    } as unknown as PrismaClient,
    sandbox: {} as SandboxProvider,
    jobs: {} as JobPublisher,
    events: {
      notify: vi.fn(async () => undefined),
      publishSpaceChange: vi.fn(async () => undefined),
    } as unknown as ThreadEvents,
    remoteRegistry: {
      revokeMember: input.revokeMember,
    },
  };
}

it("revokes remote host membership when the departed user has zero remaining spaces", async () => {
  const revokeMember = vi.fn(async () => ({}));
  await afterSpaceDeparture(
    makeDeps({ remainingSpaces: 0, scope: "central-subject-1", revokeMember }),
    { spaceId: "space-1", userId: "owner-1", departedUserId: "guest-1" },
    emptyDeparture,
  );
  expect(revokeMember).toHaveBeenCalledWith("central-subject-1");
});

it("keeps remote host membership when the departed user still belongs to another space", async () => {
  const revokeMember = vi.fn(async () => ({}));
  await afterSpaceDeparture(
    makeDeps({ remainingSpaces: 1, scope: "central-subject-1", revokeMember }),
    { spaceId: "space-1", userId: "owner-1", departedUserId: "guest-1" },
    emptyDeparture,
  );
  expect(revokeMember).not.toHaveBeenCalled();
});
