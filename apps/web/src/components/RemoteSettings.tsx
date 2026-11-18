import { Trans, useLingui } from "@lingui/react/macro";
import type { RemotePortal } from "@rakazo/contracts";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { isInsideRemoteFrame, requestRemoteHostSwitch } from "../lib/remote-frame";
import { REMOTE_PORTAL_HOST } from "../lib/remote-portal-host";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

type Portal = RemotePortal;
type Command = Awaited<ReturnType<typeof rpc.remoteHosts.set>>;

export function RemoteStateLabel({ state }: { state: Portal["devices"][number]["state"] }) {
  if (state === "off") return <Trans>Chưa bật</Trans>;
  if (state === "connecting") return <Trans>Đang kết nối</Trans>;
  if (state === "ready") return <Trans>Sẵn sàng</Trans>;
  if (state === "offline") return <Trans>Ngoại tuyến</Trans>;
  return <Trans>Lỗi</Trans>;
}

export function RemoteHostControls({
  portal,
  pending,
  onSet,
}: {
  portal: Portal;
  pending: boolean;
  onSet: (deviceId: string, enabled: boolean, confirmed: boolean) => Promise<Command | null>;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  if (portal.devices.length === 0) return null;
  return (
    <SettingsGroup title={<Trans>Kết nối từ xa</Trans>} data-testid="remote-settings">
      {portal.devices.map((device) => (
        <SettingsRow
          key={device.deviceId}
          label={
            <Label htmlFor={`remote-${device.deviceId}`} className="text-body font-normal">
              <span className="block break-all">{device.logicalHost}</span>
              <span className="text-muted-foreground">
                <RemoteStateLabel state={device.state} />
              </span>
            </Label>
          }
          control={
            <Switch
              id={`remote-${device.deviceId}`}
              data-testid={`remote-toggle-${device.deviceId}`}
              checked={device.remoteEnabled}
              disabled={pending}
              onCheckedChange={(checked) => {
                void onSet(device.deviceId, checked, false).then((result) => {
                  setConfirmId(
                    result?.kind === "needs-confirmation" || result?.kind === "occupied"
                      ? device.deviceId
                      : null,
                  );
                });
              }}
            />
          }
        />
      ))}
      {confirmId ? (
        <SettingsRow
          label={
            <p className="text-body text-foreground">
              <Trans>Máy kia sẽ mất kết nối từ xa.</Trans>
            </p>
          }
          control={
            <div className="flex gap-2">
              <Button variant="outline" disabled={pending} onClick={() => setConfirmId(null)}>
                <Trans>Hủy</Trans>
              </Button>
              <Button
                type="button"
                className="min-h-11"
                data-testid="remote-move-confirm"
                disabled={pending}
                onClick={() => {
                  void onSet(confirmId, true, true).then((result) => {
                    if (result) setConfirmId(null);
                  });
                }}
              >
                <Trans>Chuyển</Trans>
              </Button>
            </div>
          }
        />
      ) : null}
    </SettingsGroup>
  );
}

/** Opening another computer is separate from allowing remote access to this one. */
export function RemoteSettings() {
  const { t } = useLingui();
  const connectLabelId = useId();
  const [portal, setPortal] = useState<Portal | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const changeServer = desktopBridge()?.server?.change;
  const inRemoteFrame = isInsideRemoteFrame();
  useEffect(() => {
    let active = true;
    void rpc.remoteHosts
      .list()
      .then((next) => {
        if (active) setPortal(next);
      })
      .catch(() => {
        if (active) setError(t`Không tải được danh sách máy.`);
      });
    return () => {
      active = false;
    };
  }, [attempt, t]);
  return (
    <div className="space-y-4">
      {portal ? (
        <RemoteHostControls
          portal={portal}
          pending={pending}
          onSet={async (deviceId, enabled, confirmed) => {
            setPending(true);
            setError(null);
            try {
              const result = await rpc.remoteHosts.set({ deviceId, enabled, confirmed });
              setPortal(result.portal);
              return result;
            } catch (cause) {
              setError(errorText(cause));
              return null;
            } finally {
              setPending(false);
            }
          }}
        />
      ) : null}
      <SettingsGroup>
        <SettingsRow
          label={
            <span id={connectLabelId}>
              <Trans>Kết nối tới máy khác</Trans>
            </span>
          }
          control={
            changeServer ? (
              <Button
                aria-labelledby={connectLabelId}
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  void changeServer().catch((cause: unknown) => setError(errorText(cause)));
                }}
              >
                <Trans>Mở</Trans>
              </Button>
            ) : inRemoteFrame ? (
              <Button
                aria-labelledby={connectLabelId}
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  void requestRemoteHostSwitch();
                }}
              >
                <Trans>Đổi máy chủ</Trans>
              </Button>
            ) : (
              <Button
                aria-labelledby={connectLabelId}
                variant="outline"
                className="min-h-11"
                render={<a href={`https://${REMOTE_PORTAL_HOST}`} />}
              >
                <Trans>Mở bản web</Trans>
              </Button>
            )
          }
        />
      </SettingsGroup>
      {error ? (
        <div role="alert" className="space-y-2 text-body text-destructive">
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            <Trans>Thử lại</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
