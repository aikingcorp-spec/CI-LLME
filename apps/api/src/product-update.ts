import type { ServerUpdateCheck, ServerUpdateRun, ServerUpdateStatus } from "@rakazo/contracts";

/**
 * What this process can say about updating itself.
 *
 * The desktop app reads https://dl.vnbot.run/desktop/ through its signed bridge.
 * That feed is not a server or Docker installer. The Compose sidecar in this tree
 * still targets the upstream image repository, so this process does not call it
 * and does not git-fetch. Until a VNBot server feed exists, status is the installed
 * metadata we actually have, check says the latest release cannot be read, and
 * apply is refused.
 */
export const MANUAL_PRODUCT_UPDATE =
  "Download a newer VNBot package from the place you installed this one, then start it again.";

const SHA = /^[0-9a-f]{7,64}$/;
const TAG = /^[A-Za-z0-9._+-]{1,128}$/;
const KNOWN_REASONS = new Set(["unconfigured", "no-release", "offline", "error"]);

export interface InstalledProductFacts {
  revision: string | null;
  /** True when Compose named the project. The name is not part of the status. */
  compose: boolean;
}

/** A configured update service. It is not given a repository or branch from the request. */
export interface ProductUpdateProbe {
  check(): Promise<ServerUpdateCheck>;
  apply(): Promise<ServerUpdateRun>;
}

export class UpdateNotConfigured extends Error {
  constructor() {
    super("Update is not configured.");
  }
}

/** No server installer feed is configured for this installation. */
export function serverUpdateProbeFromConfiguration(): ProductUpdateProbe | null {
  return null;
}

export function installedProductStatus(
  facts: InstalledProductFacts,
  probe: ProductUpdateProbe | null,
): ServerUpdateStatus {
  const revision = sha(facts.revision);
  const connected = probe !== null;
  return {
    supported: connected,
    unsupportedReason: null,
    installKind: connected ? "sidecar" : facts.compose ? "compose" : "source",
    manualCommands: connected ? [] : [MANUAL_PRODUCT_UPDATE],
    mode: connected ? "sidecar" : "unavailable",
    strategy: null,
    strategyNote: null,
    version: "",
    revision,
    commit: revision,
    branch: null,
    remoteUrl: null,
    dirty: false,
    dirtyPaths: [],
    image: null,
    imageTag: null,
    previousImageTag: null,
    canRollback: false,
    source: { repoUrl: "", branch: "", official: false },
    officialRepoUrl: "",
    restartSupervisor: "none",
    restartAdvice: "",
    running: false,
    lastRun: null,
  };
}

export async function checkInstalledProduct(
  probe: ProductUpdateProbe | null,
): Promise<ServerUpdateCheck> {
  if (!probe) return unavailable("unconfigured");
  try {
    return publishCheck(await probe.check());
  } catch (error) {
    return unavailable(isOffline(error) ? "offline" : "error");
  }
}

export async function applyInstalledProduct(
  probe: ProductUpdateProbe | null,
): Promise<ServerUpdateRun> {
  if (!probe) throw new UpdateNotConfigured();
  try {
    const run = await probe.apply();
    if (!run.ok) throw new Error("The update could not be completed.");
    return publishRun(run);
  } catch (error) {
    if (error instanceof UpdateNotConfigured) throw error;
    throw new Error("The update could not be completed.");
  }
}

function unavailable(reason: string): ServerUpdateCheck {
  return {
    status: "unavailable",
    reason,
    changed: [],
    commit: null,
    targetCommit: null,
    targetTag: null,
    behindBy: 0,
  };
}

function publishCheck(check: ServerUpdateCheck): ServerUpdateCheck {
  const commit = sha(check.commit);
  const targetCommit = sha(check.targetCommit);
  const targetTag = tag(check.targetTag);
  const behind = behindBy(check.behindBy);
  if (check.status === "up-to-date") {
    return {
      status: "up-to-date",
      reason: null,
      changed: [],
      commit,
      targetCommit: null,
      targetTag: null,
      behindBy: 0,
    };
  }
  if (check.status === "dirty") {
    return {
      status: "dirty",
      reason: null,
      changed: [],
      commit,
      targetCommit,
      targetTag,
      behindBy: 0,
    };
  }
  if (check.status === "available") {
    if (!targetTag && !targetCommit) return unavailable("no-release");
    return {
      status: "available",
      reason: null,
      changed: [],
      commit,
      targetCommit,
      targetTag,
      behindBy: behind,
    };
  }
  const reason =
    check.reason && KNOWN_REASONS.has(check.reason)
      ? check.reason
      : check.reason
        ? "error"
        : "no-release";
  return unavailable(reason);
}

function publishRun(run: ServerUpdateRun): ServerUpdateRun {
  return {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ok: run.ok,
    fromCommit: sha(run.fromCommit),
    toCommit: sha(run.toCommit),
    fromTag: tag(run.fromTag),
    toTag: tag(run.toTag),
    strategy: run.strategy,
    repoUrl: "",
    branch: "",
    restart: run.restart,
    restartAdvice: "",
    error: null,
    steps: [],
  };
}

function sha(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return SHA.test(trimmed) ? trimmed : null;
}

function tag(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!TAG.test(trimmed) || /rakazo/i.test(trimmed)) return null;
  return trimmed;
}

function behindBy(value: number): number {
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function isOffline(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("eai_again") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}
