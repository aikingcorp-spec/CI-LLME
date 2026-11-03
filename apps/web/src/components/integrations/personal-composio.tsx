import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Disclosure, Input } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** Personal broker setup is optional; manual MCP works without it. */
export function PersonalComposio({ onSaved }: { onSaved?: () => Promise<unknown> }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const setup = useQuery(queries.integrationSetup.get.queryOptions());
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = setup.data?.providers.some(
    (entry) => entry.id === "composio" && entry.configured,
  );
  if (!setup.data?.canConfigure) return null;
  return (
    <Disclosure
      summary={
        configured ? (
          <Trans>Composio connected</Trans>
        ) : (
          <Trans>Connect with your Composio key</Trans>
        )
      }
      className="text-sm text-muted-foreground"
    >
      <form
        className="mt-3 space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await rpc.integrationSetup.save({ provider: "composio", apiKey: key });
            setKey("");
            await setup.refetch();
            await onSaved?.();
          } catch (err) {
            setError(errorText(err, t`Could not save your Composio key`));
          } finally {
            setBusy(false);
          }
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
          placeholder={t`Your Composio API key`}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !key.trim()}>
          {busy ? <Trans>Checking…</Trans> : <Trans>Check and save</Trans>}
        </Button>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </Disclosure>
  );
}
