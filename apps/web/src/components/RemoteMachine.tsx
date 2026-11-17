import { Trans } from "@lingui/react/macro";
import { Button, Spinner } from "@rakazo/ui-web";
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

type Entry = { href: string; origin: string; userId: string; deviceId: string };

/** A computer that just started needs a few seconds before its connection answers. */
const TRIES = 5;
const TRY_MS = 15_000;
const RETRY_DELAY_MS = 3_000;

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
  const tries = useRef(0);
  // Each try asks for a fresh entry ticket: a page that never answered never used its own.
  const retryOrFail = useRef(() => {});
  retryOrFail.current = () => {
    setEntry(null);
    tries.current += 1;
    if (tries.current >= TRIES) {
      setFailed(true);
      return;
    }
    window.setTimeout(() => setAttempt((value) => value + 1), RETRY_DELAY_MS);
  };
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
        if (active) retryOrFail.current();
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
      if (!ready.current) retryOrFail.current();
    }, TRY_MS);
    const receive = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === current.origin &&
        event.data?.type === "vnbot.remote.switch-host" &&
        !leaving.current
      ) {
        leaving.current = true;
        setEntry(null);
        navigateRef.current("/app?choose=1");
        return;
      }
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
        tries.current = 0;
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
          <Trans>Máy này đang tắt hoặc mất mạng.</Trans>
        </p>
        <Button
          onClick={() => {
            tries.current = 0;
            setAttempt((value) => value + 1);
          }}
        >
          <Trans>Thử lại</Trans>
        </Button>
        <Button variant="ghost" onClick={() => navigate("/app?choose=1")}>
          <Trans>Quay lại</Trans>
        </Button>
      </main>
    );
  if (!current)
    return (
      <div className="h-full">
        <PageAccountMenu />
        <Connecting />
      </div>
    );
  return (
    <div className="relative h-full">
      {!frameReady ? (
        <div className="absolute inset-0">
          <PageAccountMenu />
          <Connecting />
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

function Connecting() {
  return (
    <div className="grid h-full place-items-center bg-background">
      <div
        role="status"
        className="flex flex-col items-center gap-3 animate-in fade-in-0 fill-mode-both delay-300 duration-300 motion-reduce:animate-none"
      >
        <Spinner className="size-6 text-muted-foreground" />
        <p className="text-body text-muted-foreground">
          <Trans>Đang kết nối tới máy…</Trans>
        </p>
      </div>
    </div>
  );
}
