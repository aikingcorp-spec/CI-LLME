import { Trans, useLingui } from "@lingui/react/macro";
import type { PairedNode } from "@rakazo/p2p-prototype/browser";
import { Button } from "@rakazo/ui-web/components/ui/button";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { LoadingState } from "../components/ai/primitives";
import { LanguageSwitch } from "../components/LanguageSwitch";
import type { WebP2PClient } from "../lib/p2p-client";
import { webP2PClient } from "../lib/p2p-client";
import { queryClient } from "../lib/query";
import { clearSpaceSelection } from "../lib/rpc";

type PairingClient = Pick<
  WebP2PClient,
  "getSnapshot" | "subscribe" | "nodes" | "pair" | "connect" | "disconnect"
>;

function PairingLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-6 bg-background px-4 py-6 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/app" className="inline-flex min-h-11 items-center text-link underline">
          <Trans>Go home</Trans>
        </Link>
        <LanguageSwitch />
      </header>
      <h1 className="text-2xl font-semibold">
        <Trans>Pair a computer</Trans>
      </h1>
      {children}
    </main>
  );
}

export function PairingPage({ client: supplied }: { client?: PairingClient }) {
  const [client] = useState(() => supplied ?? webP2PClient());
  return client ? (
    <ConfiguredPairing client={client} />
  ) : (
    <PairingLayout>
      <p role="alert" className="text-sm text-destructive">
        <Trans>P2P gateway is not configured for this web build.</Trans>
      </p>
    </PairingLayout>
  );
}

function ConfiguredPairing({ client }: { client: PairingClient }) {
  const { t } = useLingui();
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [nodes, setNodes] = useState<PairedNode[]>([]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number }>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const knownNodes = useRef<string[]>([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void client
      .nodes()
      .then((result) => {
        if (!active) return;
        if (pairing && result.some((node) => !knownNodes.current.includes(node.nodeId)))
          setPairing(undefined);
        knownNodes.current = result.map((node) => node.nodeId);
        setNodes(result);
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, refresh, pairing]);
  useEffect(() => {
    if (!pairing) return;
    const poll = setInterval(() => setRefresh((value) => value + 1), 3_000);
    const expiry = setTimeout(
      () => setPairing(undefined),
      Math.max(0, pairing.expiresAt - Date.now()),
    );
    return () => {
      clearInterval(poll);
      clearTimeout(expiry);
    };
  }, [pairing]);

  async function pair() {
    setBusy(true);
    setError(false);
    try {
      const result = await client.pair();
      if (mounted.current) setPairing(result);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function connect(nodeId: string) {
    setError(false);
    try {
      await client.connect(nodeId);
      clearSpaceSelection();
      queryClient.clear();
    } catch {
      // The shared connection state reports failure; no raw signaling error reaches the UI.
    }
  }
  const states = {
    disconnected: t`Disconnected`,
    connecting: t`Connecting…`,
    connected: t`Connected`,
    failed: t`Could not connect. Try another network.`,
  };
  return (
    <PairingLayout>
      <section className="flex flex-col items-start gap-3 rounded-xl border border-border p-4">
        <Button
          className="min-h-11"
          onClick={() => void pair()}
          disabled={busy || Boolean(pairing) || loading}
        >
          <Trans>Get pairing code</Trans>
        </Button>
        {busy ? <LoadingState label={t`Loading`} /> : null}
        {pairing ? (
          <>
            <p className="text-sm text-muted-foreground">
              <Trans>Enter this code in the desktop app. It expires in two minutes.</Trans>
            </p>
            <output
              aria-label={t`Pairing code`}
              className="max-w-full break-all font-mono text-3xl tracking-widest"
              dir="ltr"
            >
              {pairing.code}
            </output>
          </>
        ) : null}
      </section>
      <section className="flex flex-col gap-3" aria-label={t`Paired computers`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">
            <Trans>Paired computers</Trans>
          </h2>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Trans>Refresh</Trans>
          </Button>
        </div>
        {loading ? <LoadingState label={t`Loading`} /> : null}
        {!loading && !error && nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No paired computers</Trans>
          </p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {nodes.map((node) => {
            const selected = connection.nodeId === node.nodeId;
            return (
              <li
                key={node.nodeId}
                className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border p-4"
              >
                <div className="min-w-0 flex-1 basis-40">
                  <p className="break-all font-medium">{node.name || node.nodeId}</p>
                  <p role="status" className="text-sm text-muted-foreground">
                    {selected ? states[connection.state] : node.online ? t`Online` : t`Offline`}
                  </p>
                </div>
                {selected && connection.state === "connected" ? (
                  <div className="flex flex-wrap gap-2">
                    <Link
                      to="/app"
                      className="inline-flex min-h-11 items-center text-link underline"
                    >
                      <Trans>Open computer</Trans>
                    </Link>
                    <Button variant="outline" className="min-h-11" onClick={client.disconnect}>
                      <Trans>Disconnect</Trans>
                    </Button>
                  </div>
                ) : selected && connection.state === "connecting" ? (
                  <Button variant="outline" className="min-h-11" onClick={client.disconnect}>
                    <Trans>Cancel</Trans>
                  </Button>
                ) : (
                  <Button
                    className="min-h-11"
                    disabled={!node.online}
                    onClick={() => void connect(node.nodeId)}
                  >
                    <Trans>Connect</Trans>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          <Trans>Could not load pairing information</Trans>
        </p>
      ) : null}
    </PairingLayout>
  );
}
