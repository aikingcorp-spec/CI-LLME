import { createHash } from "node:crypto";

const WINDOW_MS = 15 * 60_000;

/** Database primary-key reservations bound each mailbox/action in a fixed window. */
export async function reserveMailboxAttempt(
  adapter: {
    reserveVerificationValue(data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }): Promise<boolean>;
  },
  email: string,
  action: string,
): Promise<boolean> {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  const window = Math.floor(Date.now() / WINDOW_MS);
  for (let slot = 0; slot < 10; slot += 1) {
    // Never delete an expired slot here: a concurrent request may have replaced it.
    const identifier = `mailbox-attempt:${action}:${digest}:${window}:${slot}`;
    if (
      await adapter.reserveVerificationValue({
        identifier,
        value: "reserved",
        expiresAt: new Date((window + 1) * WINDOW_MS),
      })
    )
      return true;
  }
  return false;
}
