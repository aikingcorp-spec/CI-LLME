import { writeFile } from "node:fs/promises";

export interface ScreenshotTarget {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Buffer }>;
}

/** True once the sign-in form (an email or password field) is on screen. */
export const LOGIN_READY_SCRIPT =
  'Boolean(document.querySelector(\'input[type="email"], input[type="password"], input[name="email"]\'))';

/**
 * Evidence capture for headless runs: waits until the page shows the sign-in form, then
 * writes a PNG of the window. Only used when the launcher sets RAKAZO_DESKTOP_SCREENSHOT.
 */
export async function captureWhenReady(input: {
  target: ScreenshotTarget;
  file: string;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<boolean> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.timeoutMs ?? 90_000);
  while (!input.target.isDestroyed() && now() < deadline) {
    const ready = await input.target.executeJavaScript(LOGIN_READY_SCRIPT).catch(() => false);
    if (ready === true) {
      // Let fonts and transitions settle before the frame is taken.
      await sleep(500);
      if (input.target.isDestroyed()) return false;
      await writeFile(input.file, (await input.target.capturePage()).toPNG(), { mode: 0o600 });
      return true;
    }
    await sleep(input.intervalMs ?? 500);
  }
  return false;
}
