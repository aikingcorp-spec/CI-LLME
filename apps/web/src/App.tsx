import { Trans as LocalizedText } from "@lingui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { LinkFavicons } from "@rakazo/chat-ui/web-providers";
import { LinkFaviconsContext, RemoteImagesContext } from "@rakazo/chat-ui/web-providers";
import { analyticsScreen } from "@rakazo/core";
import { buttonVariants } from "@rakazo/ui-web/components/ui/button-variants";
import { cn } from "@rakazo/ui-web/lib/utils";
import type { ComponentProps, ComponentType } from "react";
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { LoadingState } from "./components/ai/primitives";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MarkdownLinkPrompt } from "./components/markdown-link-prompt";
import { PageLoading } from "./components/PageLoading";
import { authClient } from "./lib/auth";
import { getTicketBoardEnabled, subscribeTicketBoardEnabled } from "./lib/bootstrap";
import { desktopBridge } from "./lib/desktop";
import { syncWebLogoAvatarIdentity } from "./lib/logo-avatar-activity";
import { identifyMonitoringUser } from "./lib/monitoring";
import type { WebP2PClient } from "./lib/p2p-client";
import { resetP2PClient, webP2PClient } from "./lib/p2p-client";
import { markAfterPaint, markOnce } from "./lib/performance";
import { lazyComponent } from "./lib/preload-recovery";
import { QueryUserProvider, setQueryUser } from "./lib/query";
import { getRemoteImagesEnabled, subscribeRemoteImages } from "./lib/remote-images-preference";
import { rpc } from "./lib/rpc";
import {
  holdAnonymousGate,
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./lib/session-gate";
import { completeSsoCallback, SSO_CALLBACK_PATH } from "./lib/sso-flow";

import { IntegrationCallbackPage } from "./pages/IntegrationCallback";

function lazyPage(load: () => Promise<ComponentType>) {
  return lazyComponent(async () => {
    const [Page, { TooltipScope }] = await Promise.all([
      load(),
      import("./components/TooltipScope"),
    ]);
    return function PageWithTooltips() {
      return (
        <TooltipScope>
          <Page />
        </TooltipScope>
      );
    };
  });
}

function FallbackButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="button"
      className={cn(buttonVariants({ variant: "secondary" }), className)}
      {...props}
    />
  );
}

const AuthPage = lazyComponent(() => import("./pages/Auth").then((module) => module.AuthPage));
const OnboardingPage = lazyPage(() =>
  import("./pages/Onboarding").then((module) => module.OnboardingPage),
);
const WelcomePage = lazyComponent(() =>
  import("./pages/Welcome").then((module) => module.WelcomePage),
);
const ArtifactsPage = lazyPage(() =>
  import("./pages/Artifacts").then((module) => module.ArtifactsPage),
);
const BoardPage = lazyPage(() => import("./pages/Board").then((module) => module.BoardPage));
const NavLinkPage = lazyPage(() =>
  import("./pages/NavLinkPage").then((module) => module.NavLinkPage),
);

const IntegrationSetupPage = lazyPage(() =>
  import("./pages/IntegrationSetup").then((module) => module.IntegrationSetupPage),
);

const McpOAuthCallbackPage = lazyPage(() =>
  import("./pages/McpOAuthCallback").then((module) => module.McpOAuthCallbackPage),
);

const PairingPage = lazyPage(() => import("./pages/Pairing").then((module) => module.PairingPage));

const ShellPage = lazyPage(() => import("./pages/Shell").then((module) => module.ShellPage));

function SsoCallbackPage() {
  useEffect(() => {
    completeSsoCallback();
  }, []);
  return null;
}

// Link icons come from our API, which fetches and caches them; the browser never asks the site.
const linkFavicons: LinkFavicons = {
  load: (origin) => rpc.links.favicon({ origin }),
};

/** Email and code are one flow. `/sign-up` keeps `?next` and lands on sign-in. */
function SignUpRedirect({ signedIn }: { signedIn: boolean }) {
  const [params] = useSearchParams();
  if (signedIn) return <Navigate to="/onboarding" replace />;
  const next = params.get("next");
  return <Navigate to={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"} replace />;
}

export function App() {
  const loadRemoteImages = useSyncExternalStore(
    subscribeRemoteImages,
    getRemoteImagesEnabled,
    () => false,
  );
  return (
    <RemoteImagesContext.Provider value={loadRemoteImages}>
      <LinkFaviconsContext.Provider value={linkFavicons}>
        <ErrorBoundary fallback={<AppFailed />}>
          {window.location.pathname === SSO_CALLBACK_PATH ? (
            <SsoCallbackPage />
          ) : window.location.pathname === "/integrations/callback" ? (
            <IntegrationCallbackPage />
          ) : (
            <SessionApp />
          )}
        </ErrorBoundary>
      </LinkFaviconsContext.Provider>
    </RemoteImagesContext.Provider>
  );
}

const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

function RemoteNodeGate({ client }: { client: WebP2PClient }) {
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const { pathname } = useLocation();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const wasConnected = useRef(false);
  if (connection.state === "connected") wasConnected.current = true;
  useEffect(() => {
    if (userId) void client.restore(userId).catch(() => undefined);
  }, [client, userId]);
  const outlet = (
    <QueryUserProvider value={client.getNodeUserId() ?? userId ?? null}>
      <Outlet />
    </QueryUserProvider>
  );
  if (pathname === "/app/pairing" || connection.state === "connected") return outlet;
  if (connection.state === "connecting")
    return wasConnected.current ? (
      <>
        <p role="status" className="bg-muted p-2 text-center text-sm">
          <Trans>Reconnecting…</Trans>
        </p>
        {outlet}
      </>
    ) : (
      <PageLoading />
    );
  return <Navigate to="/app/pairing" replace />;
}

function SessionApp() {
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "";
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  const signInDestination =
    next.startsWith("/") && !next.startsWith("//") && !/^\/sign-(?:in|up)(?:[/?#]|$)/.test(next)
      ? next
      : "/app";
  const ticketBoardEnabled = useSyncExternalStore(
    subscribeTicketBoardEnabled,
    getTicketBoardEnabled,
    () => false,
  );
  const session = authClient.useSession();
  const { pathname, search } = useLocation();
  const screen = analyticsScreen(pathname);
  const analyticsUserId = session.data?.user.id;
  const lastScreen = useRef<string | undefined>(undefined);
  const p2pUser = useRef(analyticsUserId);
  useLayoutEffect(() => {
    if (p2pUser.current !== analyticsUserId) resetP2PClient();
    p2pUser.current = analyticsUserId;
  }, [analyticsUserId]);
  useEffect(() => {
    // A pending session is not a sign-out; startup already tagged the signed-in user.
    if (session.isPending) return;
    void identifyMonitoringUser(Boolean(analyticsUserId));
  }, [analyticsUserId, session.isPending]);
  useEffect(() => {
    if (!analyticsUserId) {
      lastScreen.current = undefined;
      return;
    }
    if (!screen) return;
    const key = `${analyticsUserId}:${screen}`;
    if (lastScreen.current === key) return;
    lastScreen.current = key;
    void Promise.resolve()
      .then(() => rpc.analytics.screen({ screen, surface: desktopBridge() ? "desktop" : "web" }))
      .catch(() => undefined);
  }, [analyticsUserId, screen]);
  const gate = sessionGate(session);
  useEffect(() => {
    if (gate === "anonymous") resetP2PClient();
  }, [gate]);
  useLayoutEffect(() => {
    if (gate === "authenticated" || gate === "anonymous")
      syncWebLogoAvatarIdentity(analyticsUserId ?? null);
  }, [gate, analyticsUserId]);
  useEffect(() => {
    if (gate === "authenticated" || gate === "anonymous") setQueryUser(analyticsUserId ?? null);
  }, [gate, analyticsUserId]);
  const [holdingUnreachable, setHoldingUnreachable] = useState(false);
  const nextHolding = holdUnreachableGate(gate, holdingUnreachable);
  if (nextHolding !== holdingUnreachable) setHoldingUnreachable(nextHolding);
  const [holdingAnonymous, setHoldingAnonymous] = useState(false);
  const nextHoldingAnonymous = holdAnonymousGate(gate, holdingAnonymous);
  if (nextHoldingAnonymous !== holdingAnonymous) setHoldingAnonymous(nextHoldingAnonymous);

  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);

  if (showSessionUnavailable(gate, nextHolding)) {
    return <SessionUnavailable refetch={session.refetch} />;
  }
  if (gate === "loading" && !nextHoldingAnonymous) {
    return <PageLoading data-rakazo-app-state="session-pending" />;
  }

  const user = session.data?.user;
  // A build with a configured gateway starts at node selection; any other web keeps direct API access.
  const remoteClient = user && !desktopBridge()?.p2p?.local ? webP2PClient() : undefined;
  return (
    <QueryUserProvider value={user?.id ?? null}>
      <MarkdownLinkPrompt>
        <div className="h-full" data-rakazo-app-state="ready">
          <Suspense fallback={<PageLoading />}>
            <Routes>
              <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
              <Route
                path="/sign-in"
                element={user ? <Navigate to={signInDestination} replace /> : <AuthPage key="in" />}
              />
              <Route path="/sign-up" element={<SignUpRedirect signedIn={Boolean(user)} />} />
              <Route path="/forgot-password" element={<Navigate to="/sign-in" replace />} />
              <Route path="/reset-password" element={<Navigate to="/sign-in" replace />} />
              <Route
                path={MCP_OAUTH_CALLBACK_PATH}
                element={
                  user ? (
                    <McpOAuthCallbackPage />
                  ) : (
                    <Navigate
                      to={`/sign-in?next=${encodeURIComponent(pathname + search)}`}
                      replace
                    />
                  )
                }
              />
              <Route
                path="/integrations/setup"
                element={
                  user ? (
                    <IntegrationSetupPage />
                  ) : (
                    <Navigate to="/sign-in?next=/integrations/setup" replace />
                  )
                }
              />
              <Route
                element={
                  user ? (
                    remoteClient ? (
                      <RemoteNodeGate client={remoteClient} />
                    ) : (
                      <Outlet />
                    )
                  ) : (
                    <Navigate
                      to={`/sign-in?next=${encodeURIComponent(pathname + search)}`}
                      replace
                    />
                  )
                }
              >
                <Route path="/onboarding/:step?" element={<OnboardingPage />} />
                <Route path="/app/pairing" element={<PairingPage />} />
                <Route path="/app" element={<ShellPage />} />
                <Route path="/app/g/:groupId" element={<ShellPage />} />
                <Route path="/app/artifacts" element={<ArtifactsPage />} />
                <Route path="/app/artifacts/:artifactId" element={<ArtifactsPage />} />
                {ticketBoardEnabled ? <Route path="/app/board" element={<BoardPage />} /> : null}
                <Route path="/app/x/:linkId" element={<NavLinkPage />} />
                <Route path="/app/:botId" element={<ShellPage />} />
              </Route>
              <Route
                path="*"
                element={
                  user ? (
                    <NotFoundPage />
                  ) : (
                    <Navigate
                      to={`/sign-in?next=${encodeURIComponent(pathname + search)}`}
                      replace
                    />
                  )
                }
              />
            </Routes>
          </Suspense>
        </div>
      </MarkdownLinkPrompt>
    </QueryUserProvider>
  );
}

/**
 * A session lookup that never reached the server is not a sign-out, so the app
 * waits and retries here instead of routing to sign-in and stranding a signed-in
 * user. Better Auth only polls once a session exists, so the retry lives here.
 */
function SessionUnavailable({ refetch }: { refetch: () => Promise<void> }) {
  const { t } = useLingui();
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const retryImmediately = useRef(false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    let cancelled = false;
    const delay = retryImmediately.current ? 0 : sessionRetryDelayMs(attempt);
    retryImmediately.current = false;
    const timer = setTimeout(() => {
      void refetchRef.current().finally(() => {
        if (!cancelled) setAttempt((value) => value + 1);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt, retryKey]);

  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="flex flex-col items-center">
        <LoadingState label={t`Reconnecting`} />
        <p className="mt-3 text-[13.5px] text-muted-foreground/80">
          <Trans>Can&apos;t reach the server.</Trans>
        </p>
        <div className="mt-4">
          <FallbackButton
            onClick={() => {
              retryImmediately.current = true;
              setAttempt(0);
              setRetryKey((key) => key + 1);
            }}
          >
            <Trans>Retry now</Trans>
          </FallbackButton>
        </div>
      </div>
    </div>
  );
}

/** Last resort for a render failure no inner boundary caught: offer a reload instead of a blank page. */
function AppFailed() {
  return (
    <div
      className="grid h-full place-items-center bg-background px-6 text-center"
      data-rakazo-app-state="failed"
    >
      <div className="flex flex-col items-center">
        <p className="text-[13.5px] text-muted-foreground/80">
          <Trans>Something went wrong. Try again.</Trans>
        </p>
        <div className="mt-4">
          <FallbackButton onClick={() => window.location.reload()}>
            <Trans>Refresh</Trans>
          </FallbackButton>
        </div>
      </div>
    </div>
  );
}

function NotFoundPage() {
  const { i18n } = useLingui();
  const vietnamese = i18n.locale === "vi";
  return (
    <main className="grid h-full place-content-center gap-3 text-center">
      <h1>
        <LocalizedText
          id="Page not found"
          message={vietnamese ? "Không tìm thấy trang" : "Page not found"}
        />
      </h1>
      <Link
        to="/app"
        className="text-link underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
      >
        <LocalizedText id="Go home" message={vietnamese ? "Về trang chủ" : "Go home"} />
      </Link>
    </main>
  );
}
