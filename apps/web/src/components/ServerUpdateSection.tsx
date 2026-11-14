import { Trans, useLingui } from "@lingui/react/macro";
import type { ServerUpdateCheck, ServerUpdateStatus } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";

const MANUAL_PRODUCT_UPDATE =
  "Download a newer VNBot package from the place you installed this one, then start it again.";

type Load =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "offline" }
  | { kind: "error" }
  | { kind: "ready"; status: ServerUpdateStatus; check: ServerUpdateCheck | null };

function errorCodeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function failureKind(error: unknown): "forbidden" | "offline" | "error" {
  if (errorCodeOf(error) === "FORBIDDEN") return "forbidden";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("offline")
  ) {
    return "offline";
  }
  return "error";
}

function unavailable(reason: "offline" | "error"): ServerUpdateCheck {
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

function safeCommand(command: string): boolean {
  return command.trim() !== "" && !/rakazo|github\.com|ghcr\.io|[/\\]/i.test(command);
}

function CheckLine({ check }: { check: ServerUpdateCheck }) {
  const { targetTag } = check;
  if (check.status === "up-to-date") return <Trans>Up to date</Trans>;
  if (check.status === "available" && targetTag) {
    return <Trans>Version {targetTag} is available.</Trans>;
  }
  if (check.status === "available") return <Trans>An update is available.</Trans>;
  if (check.status === "dirty") return <Trans>Local changes are in the way.</Trans>;
  if (check.reason === "offline") {
    return <Trans>Offline. The latest release could not be read.</Trans>;
  }
  if (check.reason === "no-release") return <Trans>No release could be read.</Trans>;
  return <Trans>The latest release could not be read.</Trans>;
}

function ManualLine({ command }: { command: string }) {
  if (command === MANUAL_PRODUCT_UPDATE) {
    return (
      <Trans>
        Download a newer VNBot package from the place you installed this one, then start it again.
      </Trans>
    );
  }
  return <>{command}</>;
}

export function ServerUpdateSection() {
  if (desktopBridge()?.update) return null;
  return <ServerUpdateBody />;
}

function ServerUpdateBody() {
  const { t } = useLingui();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [action, setAction] = useState<null | "check" | "update">(null);
  const pending = useRef(false);

  useEffect(() => {
    let stopped = false;
    void rpc.updater.status().then(
      (status) => {
        if (!stopped) setLoad({ kind: "ready", status, check: null });
      },
      (error: unknown) => {
        if (stopped) return;
        const kind = failureKind(error);
        setLoad({
          kind: kind === "forbidden" ? "forbidden" : kind === "offline" ? "offline" : "error",
        });
      },
    );
    return () => {
      stopped = true;
    };
  }, []);

  async function reload() {
    if (pending.current) return;
    pending.current = true;
    setAction("check");
    try {
      const status = await rpc.updater.status();
      setLoad({ kind: "ready", status, check: null });
    } catch (error) {
      const kind = failureKind(error);
      setLoad({
        kind: kind === "forbidden" ? "forbidden" : kind === "offline" ? "offline" : "error",
      });
    } finally {
      pending.current = false;
      setAction(null);
    }
  }

  async function onCheck() {
    if (pending.current || load.kind !== "ready") return;
    pending.current = true;
    setAction("check");
    try {
      const check = await rpc.updater.check({});
      setLoad({ kind: "ready", status: load.status, check });
    } catch (error) {
      const kind = failureKind(error);
      if (kind === "forbidden") setLoad({ kind: "forbidden" });
      else setLoad({ kind: "ready", status: load.status, check: unavailable(kind) });
    } finally {
      pending.current = false;
      setAction(null);
    }
  }

  async function onUpdate() {
    if (pending.current || load.kind !== "ready") return;
    pending.current = true;
    setAction("update");
    try {
      await rpc.updater.apply({});
      const check = await rpc.updater.check({});
      setLoad({ kind: "ready", status: load.status, check });
    } catch (error) {
      const kind = failureKind(error);
      if (kind === "forbidden") setLoad({ kind: "forbidden" });
      else
        setLoad({
          kind: "ready",
          status: load.status,
          check: unavailable(kind === "offline" ? "offline" : "error"),
        });
    } finally {
      pending.current = false;
      setAction(null);
    }
  }

  const revision = load.kind === "ready" ? load.status.revision?.slice(0, 12) : null;
  return (
    <section
      data-testid="server-update-settings"
      className="mt-5 rounded-xl border border-border px-4 py-4"
    >
      <SectionHeading variant="heading">
        <Trans>This installation</Trans>
      </SectionHeading>
      {load.kind === "forbidden" ? (
        <p role="status" className="mt-3 text-body text-muted-foreground">
          <Trans>Only the owner of this installation can check for updates.</Trans>
        </p>
      ) : null}
      {load.kind === "offline" || load.kind === "error" ? (
        <>
          <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-body text-muted-foreground">
              <Trans>Installed version unavailable</Trans>
            </span>
            <Button variant="outline" disabled={action !== null} onClick={() => void reload()}>
              {action ? <Trans>Checking…</Trans> : <Trans>Check for updates</Trans>}
            </Button>
          </div>
          <p role="status" className="mt-2 text-body text-muted-foreground">
            {load.kind === "offline" ? (
              <Trans>Offline. The latest release could not be read.</Trans>
            ) : (
              <Trans>The latest release could not be read.</Trans>
            )}
          </p>
        </>
      ) : null}
      {load.kind === "ready" ? (
        <ReadyBody
          load={load}
          action={action}
          versionLabel={
            load.status.version
              ? `v${load.status.version}`
              : load.status.revision
                ? t`Build ${revision}`
                : null
          }
          onCheck={() => void onCheck()}
          onUpdate={() => void onUpdate()}
        />
      ) : null}
    </section>
  );
}

function ReadyBody({
  load,
  action,
  versionLabel,
  onCheck,
  onUpdate,
}: {
  load: Extract<Load, { kind: "ready" }>;
  action: null | "check" | "update";
  versionLabel: string | null;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const { status, check } = load;
  const showUpdate =
    status.supported &&
    status.mode === "sidecar" &&
    check?.status === "available" &&
    !status.running;
  const showManual = !status.supported && check?.status !== "up-to-date";
  const detail =
    check?.reason &&
    !["unconfigured", "no-release", "offline", "error"].includes(check.reason) &&
    safeCommand(check.reason)
      ? check.reason
      : null;
  return (
    <>
      <div className="mt-3 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-body text-muted-foreground">
          {versionLabel ?? <Trans>Installed version unavailable</Trans>}
        </span>
        <Button
          variant="outline"
          disabled={action !== null || status.running}
          onClick={showUpdate ? onUpdate : onCheck}
        >
          {action === "update" || (status.running && status.supported) ? (
            <Trans>Updating…</Trans>
          ) : action === "check" || status.running ? (
            <Trans>Checking…</Trans>
          ) : showUpdate ? (
            <Trans>Update</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
      </div>
      <p role="status" className="mt-2 text-body text-muted-foreground">
        {check ? <CheckLine check={check} /> : null}
        {showManual
          ? status.manualCommands.filter(safeCommand).map((command) => (
              <span key={command} className="block">
                <ManualLine command={command} />
              </span>
            ))
          : null}
      </p>
      {detail ? (
        <details className="mt-2">
          <summary className="text-body text-muted-foreground">
            <Trans>Details</Trans>
          </summary>
          <p className="mt-2 text-body text-muted-foreground">{detail}</p>
        </details>
      ) : null}
    </>
  );
}
