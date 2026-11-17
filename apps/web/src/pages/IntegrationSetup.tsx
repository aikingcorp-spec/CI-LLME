import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { Button, OptionSelect, Spinner } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { IntegrationSetup } from "../components/integrations/IntegrationSetup";
import { PageAccountMenu } from "../components/PageAccountMenu";
import { rpc } from "../lib/rpc";

export function IntegrationSetupPage() {
  const navigate = useNavigate();
  const { t } = useLingui();
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setReady(false);
    setError(false);
    let cancelled = false;
    void rpc.bots
      .list()
      .then((rows) => {
        if (cancelled) return;
        if (!rows.length) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setBots(rows);
        setBotId(rows[0]?.id ?? "");
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);
  return (
    <div className="min-h-full bg-background px-6 py-12">
      <PageAccountMenu destination="/sign-in?next=%2Fintegrations%2Fsetup" />
      <div className="mx-auto max-w-[560px]">
        <Button variant="ghost" className="mb-6" render={<Link to="/app" />}>
          <Trans>Back to chat</Trans>
        </Button>
        {bots.length > 1 ? (
          <OptionSelect
            aria-label={t`Bot`}
            value={botId || null}
            options={bots.map((bot) => ({ value: bot.id, label: bot.name }))}
            onValueChange={setBotId}
            className="mb-6"
          />
        ) : null}
        {ready ? (
          <IntegrationSetup
            botId={botId || undefined}
            onDone={() => navigate(bots.length ? "/app" : "/onboarding")}
          />
        ) : (
          <p>
            {error ? (
              t`Could not load bots. Reload to try again.`
            ) : (
              <Spinner aria-label={t`Loading…`} />
            )}
          </p>
        )}
      </div>
    </div>
  );
}
