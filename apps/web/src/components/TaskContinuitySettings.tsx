import { Trans, useLingui } from "@lingui/react/macro";
import { Switch } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

export function TaskContinuitySettings() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const rpc = useSpaceRpc();
  const client = useQueryClient();
  const me = useQuery(queries.me.queryOptions());
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me.data?.taskContinuitySupported) return null;
  return (
    <SettingsGroup data-testid="task-continuity-settings">
      <SettingsRow
        label={
          <label htmlFor={id}>
            <Trans>Continue unfinished tasks</Trans>
          </label>
        }
        control={
          <Switch
            id={id}
            aria-describedby={`${id}-detail`}
            checked={me.data.taskContinuityEnabled ?? false}
            disabled={busy}
            onCheckedChange={async (enabled) => {
              setBusy(true);
              setError(null);
              try {
                const next = await rpc.preferences.update({ taskContinuityEnabled: enabled });
                client.setQueryData(queries.me.queryKey(), next);
              } catch (error) {
                setError(errorText(error, t`Could not save task settings`));
              } finally {
                setBusy(false);
              }
            }}
          />
        }
      >
        <p id={`${id}-detail`} className="mt-1 text-xs text-muted-foreground">
          <Trans>Checks for remaining work before stopping. Uses extra model requests.</Trans>
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </SettingsGroup>
  );
}
