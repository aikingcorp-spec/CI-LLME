import { Trans, useLingui } from "@lingui/react/macro";
import type { RemotePortal } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { useInRouterContext, useLocation } from "react-router-dom";
import { useQueryUserId } from "../lib/query";
import { portalEntry, readRememberedComputer, rememberComputer } from "../lib/remembered-computer";
import { machinePath } from "../lib/remote-frame";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { PageAccountMenu } from "./PageAccountMenu";
import { RemoteStateLabel } from "./RemoteSettings";
import { SettingsGroup, SettingsRow } from "./SettingsRows";
import { VnbotWordmark } from "./VnbotWordmark";

function preferenceStore() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function RemotePortalView({
  portal,
  rememberedDeviceId = null,
  autoOpen = true,
  onOpen,
  onDismissInvited,
}: {
  portal: RemotePortal;
  rememberedDeviceId?: string | null;
  autoOpen?: boolean;
  onOpen?: (deviceId: string) => void;
  onDismissInvited?: (deviceId: string) => void;
}) {
  const entry = portalEntry({ portal, rememberedDeviceId });
  const autoDeviceId = entry.kind === "auto" ? entry.deviceId : null;
  useEffect(() => {
    if (autoOpen && autoDeviceId !== null) onOpen?.(autoDeviceId);
  }, [autoOpen, autoDeviceId, onOpen]);
  return (
    <div data-testid="remote-portal">
      {entry.kind === "choose" && entry.rememberedAbsent ? (
        <p
          role="status"
          data-testid="remote-portal-remembered-absent"
          className="text-center text-body-sm text-muted-foreground"
        >
          <Trans>Máy đã dùng trước không còn để kết nối.</Trans>
        </p>
      ) : null}
      {portal.devices.length === 0 ? (
        <div data-testid="remote-portal-empty" className="space-y-4 text-center">
          <p>
            <Trans>Chưa có máy nào để kết nối.</Trans>
          </p>
          <Button render={<a href="/tai-app" />}>
            <Trans>Tải VNBot</Trans>
          </Button>
        </div>
      ) : (
        <SettingsGroup data-testid="remote-portal-devices">
          {portal.devices.map((device) => (
            <SettingsRow
              key={device.deviceId}
              label={
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span
                      className="block break-all"
                      data-testid={
                        autoDeviceId === device.deviceId ? "remote-portal-open" : undefined
                      }
                    >
                      {device.logicalHost}
                    </span>
                    {device.invited ? (
                      <span
                        data-testid={`remote-portal-invited-${device.deviceId}`}
                        className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 text-body-sm text-muted-foreground"
                      >
                        <Trans>Được mời</Trans>
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">
                    <RemoteStateLabel state={device.state} />
                  </span>
                </span>
              }
              control={
                device.state === "ready" || (device.invited && onDismissInvited) ? (
                  <div className="flex items-center gap-2">
                    {device.invited && onDismissInvited ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`remote-portal-dismiss-${device.deviceId}`}
                        onClick={() => onDismissInvited(device.deviceId)}
                      >
                        <Trans>Bỏ</Trans>
                      </Button>
                    ) : null}
                    {device.state === "ready" ? (
                      <Button
                        variant="outline"
                        data-testid={`remote-portal-pick-${device.deviceId}`}
                        onClick={() => onOpen?.(device.deviceId)}
                      >
                        <Trans>Mở</Trans>
                      </Button>
                    ) : null}
                  </div>
                ) : undefined
              }
            />
          ))}
        </SettingsGroup>
      )}
      {portal.devices.length > 0 ? (
        <Button variant="ghost" className="mx-auto mt-4 flex" render={<a href="/tai-app" />}>
          <Trans>Tải VNBot</Trans>
        </Button>
      ) : null}
    </div>
  );
}

type PortalState =
  | { kind: "loading" }
  | { kind: "ready"; portal: RemotePortal }
  | { kind: "error"; message: string };

function openableHref(href: unknown): string | null {
  if (typeof href !== "string" || href.trim().length === 0) return null;
  return href;
}

function RouterRemotePortalPage() {
  const { search } = useLocation();
  return <RemotePortalPageBody choosing={new URLSearchParams(search).get("choose") === "1"} />;
}

/** Account controls stay available even while the host list is pending or unavailable. */
export function RemotePortalPage() {
  const inRouter = useInRouterContext();
  if (inRouter) return <RouterRemotePortalPage />;
  return (
    <RemotePortalPageBody
      choosing={new URLSearchParams(window.location.search).get("choose") === "1"}
    />
  );
}

function RemotePortalPageBody({ choosing }: { choosing: boolean }) {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const portalRef = useRef<RemotePortal | null>(null);
  const enterGeneration = useRef(0);
  const [listedUserId, setListedUserId] = useState(userId);
  const [state, setState] = useState<PortalState>({ kind: "loading" });
  portalRef.current = state.kind === "ready" ? state.portal : null;
  const [attempt, setAttempt] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    return () => {
      enterGeneration.current += 1;
    };
  }, [userId]);
  useEffect(() => {
    let active = true;
    const requestedFor = userId;
    setState({ kind: "loading" });
    void rpc.remoteHosts
      .list()
      .then((portal) => {
        if (!active || userIdRef.current !== requestedFor) return;
        setState({ kind: "ready", portal });
      })
      .catch((error: unknown) => {
        if (!active || userIdRef.current !== requestedFor) return;
        setState({ kind: "error", message: errorText(error, t`Không tải được danh sách máy.`) });
      });
    return () => {
      active = false;
    };
  }, [attempt, t, userId]);
  const open = useCallback(
    (deviceId: string) => {
      const requestedFor = userIdRef.current;
      const generation = ++enterGeneration.current;
      const origin = window.location.origin;
      const portal = portalRef.current;
      const slug =
        portal?.devices.find((device) => device.deviceId === deviceId)?.shortCode ||
        (portal?.kind === "open" && portal.deviceId === deviceId ? portal.shortCode : null) ||
        deviceId;
      setOpenError(null);
      void rpc.remoteHosts
        .enter({ deviceId })
        .then((result) => {
          if (generation !== enterGeneration.current || userIdRef.current !== requestedFor) return;
          const href = openableHref(result.href);
          if (href === null) {
            setOpenError(t`Chưa mở được máy này. Vui lòng thử lại.`);
            return;
          }
          rememberComputer(preferenceStore(), { userId: requestedFor, origin, deviceId });
          window.location.assign(machinePath(slug));
        })
        .catch((error: unknown) => {
          if (generation !== enterGeneration.current || userIdRef.current !== requestedFor) return;
          setOpenError(errorText(error, t`Chưa mở được máy này. Vui lòng thử lại.`));
        });
    },
    [t],
  );
  const dismissInvited = useCallback(
    (deviceId: string) => {
      setOpenError(null);
      void rpc.remoteHosts
        .revoke({ deviceId })
        .then((result) => {
          setState({ kind: "ready", portal: result.portal });
        })
        .catch((error: unknown) => {
          setOpenError(errorText(error, t`Không tải được danh sách máy.`));
        });
    },
    [t],
  );
  if (listedUserId !== userId) {
    setListedUserId(userId);
    setState({ kind: "loading" });
    setOpenError(null);
  }
  const origin = window.location.origin;
  const rememberedDeviceId = readRememberedComputer(preferenceStore(), { userId, origin });
  const entry =
    state.kind === "ready" ? portalEntry({ portal: state.portal, rememberedDeviceId }) : null;
  const showRetry = state.kind === "error" || entry?.kind === "choose" || choosing;
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-5 py-24">
      <PageAccountMenu />
      <div className="w-full max-w-md space-y-6">
        <VnbotWordmark variant="wordmark" className="mx-auto h-9 w-auto" />
        <h1 className="text-center text-heading">
          <Trans>Kết nối tới máy khác</Trans>
        </h1>
        {state.kind === "loading" ? (
          <p role="status" className="text-center text-muted-foreground">
            <Trans>Đang tải…</Trans>
          </p>
        ) : null}
        {state.kind === "ready" ? (
          <RemotePortalView
            portal={state.portal}
            rememberedDeviceId={rememberedDeviceId}
            autoOpen={!choosing}
            onOpen={open}
            onDismissInvited={dismissInvited}
          />
        ) : null}
        {state.kind === "error" ? (
          <p role="alert" className="text-body-sm text-destructive">
            {state.message}
          </p>
        ) : null}
        {openError ? (
          <p role="alert" className="text-body-sm text-destructive">
            {openError}
          </p>
        ) : null}
        {showRetry ? (
          <div className="text-center">
            <Button
              variant="ghost"
              onClick={() => {
                setOpenError(null);
                setAttempt((value) => value + 1);
              }}
            >
              <Trans>Thử lại</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
