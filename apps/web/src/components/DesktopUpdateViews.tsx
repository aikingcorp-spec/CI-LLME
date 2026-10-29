import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useContext } from "react";
import { UpdatesContext } from "./DesktopUpdates";

export function DesktopUpdatePrompt({ onLater }: { onLater: (version: string | null) => void }) {
  const { t } = useLingui();
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act } = updates;
  return (
    <aside
      aria-label={t`Desktop update`}
      className="w-full rounded-xl border border-border bg-card p-3 text-card-foreground shadow-lg"
    >
      <div className="flex items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => void act(state.phase === "ready" ? "install" : "check")}
        >
          {state.phase === "ready" ? (
            <Trans>Restart to update</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onLater(state.availableVersion)}>
          <Trans>Later</Trans>
        </Button>
      </div>
      {error || state.message ? (
        <p role="status" className="mt-2 text-sm">
          {error ?? state.message}
        </p>
      ) : null}
    </aside>
  );
}

export function DesktopUpdateSection() {
  const updates = useContext(UpdatesContext);
  if (!updates?.state) return null;
  const { state, busy, error, act, confirmedCheck } = updates;
  const ready = state.phase === "ready";
  const downloading = state.phase === "available" || state.phase === "downloading";
  return (
    <section
      data-testid="desktop-update-settings"
      className="mt-5 rounded-xl border border-border px-4 py-4"
    >
      <h3 className="text-heading3 font-medium text-foreground">
        <Trans>Desktop app</Trans>
      </h3>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">v{state.currentVersion}</span>
        <Button
          variant="outline"
          disabled={busy || downloading || state.phase === "checking"}
          onClick={() => void act(ready ? "install" : "check")}
        >
          {ready ? (
            <Trans>Restart to update</Trans>
          ) : downloading ? (
            <Trans>Downloading…</Trans>
          ) : busy || state.phase === "checking" ? (
            <Trans>Checking…</Trans>
          ) : (
            <Trans>Check for updates</Trans>
          )}
        </Button>
      </div>
      <p role="status" className="mt-2 text-sm text-muted-foreground">
        {error ??
          state.message ??
          (downloading ? (
            `${state.percent ?? 0}%`
          ) : state.phase === "idle" && confirmedCheck && state.checkedAt === confirmedCheck ? (
            <Trans>Up to date</Trans>
          ) : null)}
      </p>
    </section>
  );
}
