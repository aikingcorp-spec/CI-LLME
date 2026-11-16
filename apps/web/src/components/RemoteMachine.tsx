import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryUserId } from "../lib/query";
import {
  clearPendingFrameInvite,
  frameEntry,
  frameNavigation,
  machinePath,
  pendingFrameInvite,
} from "../lib/remote-frame";
import { rpc } from "../lib/rpc";
import { signOut } from "../lib/sign-out";
import { PageAccountMenu } from "./PageAccountMenu";
import { PageLoading } from "./PageLoading";

type Entry = { href: string; origin: string; userId: string; deviceId: string };

/** The portal never gives a remote computer access to its own origin or session. */
export function RemoteMachinePage() {
  const { deviceId = "" } = useParams();
  const userId = useQueryUserId();
  const navigate = useNavigate();
  // React Router makes a new navigate on every address change; readiness must not restart then.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const frame = useRef<HTMLIFrameElement>(null);
  const leaving = useRef(false);
  const ready = useRef(false);
  const [frameReady, setFrameReady] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setEntry(null);
    setFailed(false);
    if (!userId) return;
    const invite = pendingFrameInvite(
      deviceId,
      new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? undefined,
    );
    const page = window.location.pathname.slice(`/m/${deviceId}`.length) + window.location.search;
    // Clear the invitation from the visible URL; it is carried only in the host's fragment.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    void rpc.remoteHosts
      .enter({ deviceId })
      .then((result) => {
        if (!active) return;
        if (!result.href) throw new Error("Computer unavailable");
        setEntry({
          ...frameEntry(result.href, invite, page || "/app", window.location.origin),
          userId,
          deviceId,
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [deviceId, userId, attempt]);
  const current = entry?.userId === userId && entry.deviceId === deviceId ? entry : null;
  useEffect(() => {
    if (!current) return;
    ready.current = false;
    setFrameReady(false);
    const timeout = window.setTimeout(() => {
      if (!ready.current) {
        setEntry(null);
        setFailed(true);
      }
    }, 30_000);
    const receive = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === current.origin &&
        event.data?.type === "vnbot.remote.signed-out" &&
        !leaving.current
      ) {
        leaving.current = true;
        setEntry(null);
        void signOut(`/sign-in?next=${encodeURIComponent(machinePath(deviceId))}`);
        return;
      }
      const path = frameNavigation(event, {
        origin: current.origin,
        source: frame.current?.contentWindow ?? null,
      });
      if (path) {
        ready.current = true;
        setFrameReady(true);
        clearPendingFrameInvite();
        navigateRef.current(machinePath(deviceId, path), { replace: true });
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [current, deviceId]);
  if (failed)
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4">
        <PageAccountMenu />
        <p>
          <Trans>Chưa mở được máy này. Vui lòng thử lại.</Trans>
        </p>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          <Trans>Thử lại</Trans>
        </Button>
        <Button variant="ghost" onClick={() => navigate("/app")}>
          <Trans>Quay lại</Trans>
        </Button>
      </main>
    );
  if (!current)
    return (
      <div className="h-full">
        <PageAccountMenu />
        <PageLoading />
      </div>
    );
  return (
    <div className="relative h-full">
      {!frameReady ? (
        <div className="absolute inset-0">
          <PageAccountMenu />
          <PageLoading />
        </div>
      ) : null}
      <iframe
        ref={frame}
        key={`${userId}:${deviceId}`}
        title="VNBot"
        src={current.href}
        className={`h-full w-full border-0${frameReady ? "" : " invisible"}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
        allow="microphone; autoplay; clipboard-write; fullscreen"
        referrerPolicy="origin"
      />
    </div>
  );
}
