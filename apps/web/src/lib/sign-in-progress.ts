/**
 * Keeps the email-code sign-in step across a reload (F5) in the same tab.
 * sessionStorage only: it dies with the tab, and it never holds the code itself.
 */
export const SIGN_IN_PROGRESS_KEY = "vnbot.signIn";
/** Older than the code's lifetime, so a stale step is not restored. */
const MAX_AGE_MS = 10 * 60 * 1000;

export type SignInProgress = {
  email: string;
  /** "machine" marks a verified code whose machine is not picked yet; the router keeps this page. */
  step: "email" | "code" | "machine";
  /** Epoch ms when the last code was sent; drives the resend countdown. */
  sentAt?: number;
};

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSignInProgress(now = Date.now()): SignInProgress | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(SIGN_IN_PROGRESS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SignInProgress>;
    if (typeof value.email !== "string") return null;
    if (value.step === "machine") return { email: value.email, step: "machine" };
    if (value.step === "code") {
      const sentAt = typeof value.sentAt === "number" ? value.sentAt : NaN;
      if (!value.email || !(now - sentAt >= 0 && now - sentAt < MAX_AGE_MS)) {
        return { email: value.email, step: "email" };
      }
      return { email: value.email, step: "code", sentAt };
    }
    return { email: value.email, step: "email" };
  } catch {
    return null;
  }
}

export function writeSignInProgress(progress: SignInProgress): void {
  try {
    storage()?.setItem(SIGN_IN_PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage full or blocked: the flow still works, just without F5 restore.
  }
}

export function clearSignInProgress(): void {
  try {
    storage()?.removeItem(SIGN_IN_PROGRESS_KEY);
  } catch {
    // ignore
  }
}

/** Seconds left on the resend countdown for a code sent at `sentAt`. */
export function resendSecondsLeft(
  sentAt: number | undefined,
  total: number,
  now = Date.now(),
): number {
  if (sentAt === undefined) return 0;
  return Math.max(0, Math.min(total, Math.ceil((sentAt + total * 1000 - now) / 1000)));
}
