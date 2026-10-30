import { displayName } from "./display-name.js";
import { notificationText } from "./notification-text.js";
/** Remind once a queued run or a human wait has been sitting this long.
 *  Long enough that a short queue or stepping away stays quiet; short enough
 *  that a forgotten takeover is not silent until the next day. */
export const STUCK_WORK_NOTIFY_AFTER_MS = 4 * 60 * 60 * 1000;

/** Cancel once that same work has been sitting this long.
 *  Matches how long a takeover holds the screen, and leaves the hours after
 *  the reminder for someone to answer before the thread is freed. */
export const STUCK_WORK_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Marker on a thread.meta event so a reminder is sent once per waiting episode. */
export const STUCK_WORK_NOTICE = "stuck";

export const STUCK_WORK_STATUSES = ["queued", "waiting_input", "waiting_takeover"] as const;
export type StuckWorkStatus = (typeof STUCK_WORK_STATUSES)[number];

export type StuckWorkAction = "notify" | "expire" | "none";

export function isStuckWorkStatus(status: string): status is StuckWorkStatus {
  return (STUCK_WORK_STATUSES as readonly string[]).includes(status);
}

export function stuckWorkAgeMs(updatedAt: Date | string, now: Date): number {
  const at = updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(updatedAt);
  if (!Number.isFinite(at)) return 0;
  return now.getTime() - at;
}

/** `alreadyNotified` is for this episode (the run's current updatedAt), not an older one. */
export function stuckWorkAction(input: {
  ageMs: number;
  alreadyNotified: boolean;
}): StuckWorkAction {
  if (input.ageMs >= STUCK_WORK_EXPIRE_AFTER_MS) return "expire";
  if (input.ageMs >= STUCK_WORK_NOTIFY_AFTER_MS && !input.alreadyNotified) return "notify";
  return "none";
}

/** True once a queued or human-waiting run is old enough to call out in the activity list. */
export function isAgedStuckWork(
  status: string,
  updatedAt: Date | string,
  now = Date.now(),
): boolean {
  if (!isStuckWorkStatus(status)) return false;
  return stuckWorkAgeMs(updatedAt, new Date(now)) >= STUCK_WORK_NOTIFY_AFTER_MS;
}

export function stuckWorkExpiredNonce(runId: string): string {
  return `stuck-expired:${runId}`;
}

/** Status line left in the thread when the wait is cancelled. */
export function stuckWorkStatusMessage(status: StuckWorkStatus): string {
  switch (status) {
    case "queued":
      return "Stopped. This stayed queued without starting.";
    case "waiting_input":
      return "Stopped. This was still waiting for an answer.";
    case "waiting_takeover":
      return "Stopped. This was still waiting for you on the screen.";
  }
}

export function stuckWorkStatusMessages(): readonly string[] {
  return STUCK_WORK_STATUSES.map((status) => stuckWorkStatusMessage(status));
}

const STOPPED_PUSH_BODY: Record<StuckWorkStatus, string> = {
  queued: notificationText.stoppedQueued,
  waiting_input: notificationText.stoppedWaitingInput,
  waiting_takeover: notificationText.stoppedWaitingTakeover,
};

export type StuckAttentionKind = "help" | "takeover" | "failure";

export function stuckWorkReminder(
  status: StuckWorkStatus,
  botName: string,
): { kind: StuckAttentionKind; title: string; body: string } {
  switch (status) {
    case "queued":
      return {
        kind: "help",
        title: notificationText.stillQueued(botName),
        body: notificationText.waitingToStart,
      };
    case "waiting_input":
      return {
        kind: "help",
        title: notificationText.stillNeedsAnswer(botName),
        body: notificationText.waitingOnYou,
      };
    case "waiting_takeover":
      return {
        kind: "takeover",
        title: notificationText.stillNeedsYou(botName),
        body: notificationText.screenWaiting,
      };
  }
}

export function stuckWorkStoppedNotification(
  status: StuckWorkStatus,
  botName: string,
): { kind: "failure"; title: string; body: string } {
  return {
    kind: "failure",
    title: notificationText.stopped(botName),
    // The run keeps the English error text (old rows are matched by it); the push is Vietnamese.
    body: STOPPED_PUSH_BODY[status],
  };
}

function botLabel(name: string): string {
  return displayName(name, "Bot");
}
