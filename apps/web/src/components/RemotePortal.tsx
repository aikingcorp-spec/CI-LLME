import { Trans, useLingui } from "@lingui/react/macro";
import type { RemotePortal } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryUserId } from "../lib/query";
import { portalEntry, readRememberedComputer, rememberComputer } from "../lib/remembered-computer";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { VNBOT_DOWNLOAD_URL } from "../lib/vnbot-links";
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
  onOpen,
}: {
  portal: RemotePortal;
  rememberedDeviceId?: string | null;
  onOpen?: (deviceId: string) => void;
}) {
  const entry = portalEntry({ portal, rememberedDeviceId });
  const autoDeviceId = entry.kind === "auto" ? entry.deviceId : null;
  useEffect(() => {
    if (autoDeviceId !== null) onOpen?.(autoDeviceId);
  }, [autoDeviceId, onOpen]);
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
          <Button render={<a href={VNBOT_DOWNLOAD_URL} />}>
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
                  <span
                    className="block break-all"
                    data-testid={
                      autoDeviceId === device.deviceId ? "remote-portal-open" : undefined
                    }
                  >
                    {device.logicalHost}
                  </span>
                  <span className="text-muted-foreground">
                    <RemoteStateLabel state={device.state} />
                  </span>
                </span>
              }
              control={
                device.state === "ready" ? (
                  <Button
                    variant="outline"
                    data-testid={`remote-portal-pick-${device.deviceId}`}
                    onClick={() => onOpen?.(device.deviceId)}
                  >
                    <Trans>Mở</Trans>
                  </Button>
                ) : undefined
              }
            />
          ))}
        </SettingsGroup>
      )}
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

/** Account controls stay available even while the host list is pending or unavailable. */
export function RemotePortalPage() {
  const { t } = useLingui();
  const userId = useQueryUserId();
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const enterGeneration = useRef(0);
  const [listedUserId, setListedUserId] = useState(userId);
  const [state, setState] = useState<PortalState>({ kind: "loading" });
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
          window.location.assign(href);
        })
        .catch((error: unknown) => {
          if (generation !== enterGeneration.current || userIdRef.current !== requestedFor) return;
          setOpenError(errorText(error, t`Chưa mở được máy này. Vui lòng thử lại.`));
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
            onOpen={open}
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
        {state.kind === "error" || entry?.kind === "choose" ? (
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
