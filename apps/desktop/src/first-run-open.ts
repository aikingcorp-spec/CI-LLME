import type { DesktopSetup } from "@rakazo/contracts";

interface FirstRunOpenDeps {
  readonly url: string;
  readonly getSetup: () => DesktopSetup | null;
  readonly setSetup: (setup: DesktopSetup | null) => void;
  readonly open: (url: string) => Promise<boolean>;
  readonly persist: (setup: DesktopSetup) => Promise<void>;
  readonly onRollback?: () => void;
}

/**
 * Open the freshly started local stack for the first time.
 *
 * The page asks whether this is the machine's own host while it mounts, and
 * that answer needs `mode === "new"`, so the in-memory setup is assigned
 * before the window loads. It is only persisted once the open succeeds.
 */
export async function openFirstRunLocalStack(deps: FirstRunOpenDeps): Promise<boolean> {
  const previous = deps.getSetup();
  const next: DesktopSetup = { mode: "new", serverUrl: deps.url };
  deps.setSetup(next);
  let opened: boolean;
  try {
    opened = await deps.open(deps.url);
  } catch (error) {
    deps.setSetup(previous);
    deps.onRollback?.();
    throw error;
  }
  if (!opened) {
    deps.setSetup(previous);
    deps.onRollback?.();
    return false;
  }
  await deps.persist(next);
  return true;
}
