import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { expireComputerControl, stopCancelledGroupRuns, wakeRun } from "@rakazo/adapters";
import type { PrismaClient, SpaceDeparture, ThreadEvents } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/**
 * After someone leaves a Space, is removed, or deletes their account: tell clients their runs
 * were cancelled, stop those runs' work, release the screens they held, and start the follow-ups
 * that waited behind them. The departure is committed, so each failure is logged rather than
 * reported; expired leases and the job reconciler catch up.
 */
export async function afterSpaceDeparture(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    events: ThreadEvents;
    remoteRegistry?: {
      revokeMember?: (memberAccountId: string) => Promise<unknown>;
    };
  },
  actor: { spaceId: string; userId: string; departedUserId?: string },
  departure: SpaceDeparture,
): Promise<void> {
  await Promise.all(
    departure.events.map(({ threadId, seq }) =>
      deps.events.notify(threadId, seq).catch((error) => {
        getLogger().error("space departure realtime notification", error);
      }),
    ),
  );
  // Their routines pass to the owner, paused.
  await deps.events.publishSpaceChange?.(actor.spaceId, "routines");
  await stopCancelledGroupRuns(deps, actor, departure).catch((error) => {
    getLogger().error("space departure run teardown", error);
  });
  await Promise.all(
    departure.heldControls.map(({ computerId, leaseId }) =>
      expireComputerControl(deps, computerId, leaseId).catch((error) => {
        getLogger().error("space departure control release", error);
      }),
    ),
  );
  await Promise.all(departure.continuationRunIds.map((runId) => wakeRun(deps.jobs, runId)));

  const departedUserId = actor.departedUserId ?? actor.userId;
  const revokeMember = deps.remoteRegistry?.revokeMember;
  if (revokeMember) {
    await runAsSystem("revoke departed remote host membership", async () => {
      const remaining = await deps.prisma.spaceMember.count({
        where: { userId: departedUserId },
      });
      if (remaining > 0) return;
      const identity = await deps.prisma.account.findFirst({
        where: { userId: departedUserId, providerId: "verified-identity" },
        select: { scope: true },
      });
      if (identity?.scope) await revokeMember(identity.scope);
    }).catch((error) => {
      getLogger().error("space departure remote host revocation", error);
    });
  }
}
