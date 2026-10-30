import { execFileSync } from "node:child_process";

/** Mandatory integrity level "High" (S-1-16-12288) is what an elevated Windows token carries. */
const WINDOWS_HIGH_INTEGRITY = "S-1-16-12288";

export interface ElevationProbe {
  platform: NodeJS.Platform | string;
  getuid?: () => number;
  /** Output of `whoami /groups`. */
  whoamiGroups?: () => string;
}

/**
 * Whether the app was started as root (macOS, Linux) or as an elevated administrator (Windows).
 * A probe that cannot run answers false: the person is not locked out of the app, and a normal
 * launch is never elevated.
 */
export function isElevatedProcess(probe: ElevationProbe = defaultProbe()): boolean {
  if (probe.platform === "win32") {
    try {
      return probe.whoamiGroups?.().includes(WINDOWS_HIGH_INTEGRITY) ?? false;
    } catch {
      return false;
    }
  }
  return probe.getuid?.() === 0;
}

function defaultProbe(): ElevationProbe {
  return {
    platform: process.platform,
    getuid: process.getuid?.bind(process),
    whoamiGroups: () =>
      execFileSync("whoami", ["/groups"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      }),
  };
}
