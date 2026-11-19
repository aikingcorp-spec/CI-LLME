import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** This computer's Composio key, pasted by its owner. Optional; manual MCP works without it. */
export function PersonalComposio({ onSaved }: { onSaved?: () => Promise<unknown> }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const setup = useQuery(queries.integrationSetup.get.queryOptions());
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = setup.data?.providers.some(
    (entry) => entry.id === "composio" && entry.configured,
  );
  if (!setup.data) return null;
  // One key serves this computer; only its owner pastes it. Others only learn it is missing.
  if (!setup.data.canConfigure) {
    return configured || setup.data.providers.length === 0 ? null : (
      <p className="text-body-sm text-muted-foreground" data-testid="owner-composio-missing">
        <Trans>The owner of this computer has not added a Composio key yet.</Trans>
      </p>
    );
  }

  async function act(action: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setKey("");
      await setup.refetch();
      await onSaved?.();
      setOpen(false);
    } catch (err) {
      setError(errorText(err, failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      summary={
        configured ? (
          <Trans>Composio connected</Trans>
        ) : (
          <Trans>Connect with your Composio key</Trans>
        )
      }
      className="text-body-sm text-muted-foreground"
      data-testid="personal-composio"
    >
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void act(
            () => rpc.integrationSetup.save({ provider: "composio", apiKey: key }),
            t`Could not save your Composio key`,
          );
        }}
      >
        <a
          href="https://dashboard.composio.dev/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          <Trans>Get your project key</Trans>
        </a>
        <Input
          type="password"
          autoComplete="off"
          aria-label={t`Your Composio API key`}
          placeholder={configured ? t`Paste a replacement key` : t`Your Composio API key`}
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setError(null);
          }}
          disabled={busy}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !key.trim()}>
            {busy ? <Trans>Checking…</Trans> : <Trans>Check and save</Trans>}
          </Button>
          {configured ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act(() => rpc.integrationSetup.remove(), t`Could not remove your Composio key`)
              }
            >
              <Trans>Remove key</Trans>
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </Disclosure>
  );
}
