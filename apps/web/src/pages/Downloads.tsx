import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  toast,
} from "@rakazo/ui-web";
import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageAccountMenu } from "../components/PageAccountMenu";
import { PageLoading } from "../components/PageLoading";
import { SettingsGroup, SettingsRow } from "../components/SettingsRows";
import { VnbotWordmark } from "../components/VnbotWordmark";

type Download = { version: string; url: string } | null;
type Downloads = { windows: Download; mac: Download; linuxDeb: Download; linuxAppImage: Download };

/** Installs and updates the app on a Debian or Ubuntu server, from the same feed. */
export const LINUX_SERVER_COMMAND =
  "curl -fsSL https://dl.vnbot.run/install/vnbot-linux.sh | sudo bash";

function isDownloads(value: unknown): value is Downloads {
  return Boolean(value && typeof value === "object" && "windows" in value && "mac" in value);
}

/** Team accounts install the desktop app from here. The app updates itself afterwards. */
export function DownloadsPage() {
  const { t } = useLingui();
  const [downloads, setDownloads] = useState<Downloads | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/desktop-downloads", { credentials: "include" })
      .then(async (response) => {
        const value: unknown = response.ok ? await response.json() : null;
        if (!active) return;
        if (isDownloads(value)) setDownloads(value);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  if (!downloads && !failed)
    return (
      <div className="h-full">
        <PageAccountMenu />
        <PageLoading />
      </div>
    );
  const rows: [string, Download][] = downloads
    ? [
        ["Windows", downloads.windows],
        ["macOS", downloads.mac],
        ["Linux (.deb)", downloads.linuxDeb],
        ["Linux (AppImage)", downloads.linuxAppImage],
      ]
    : [];
  return (
    <main className="h-full overflow-y-auto bg-background px-4 py-16 text-foreground">
      <PageAccountMenu />
      <div className="mx-auto flex w-[560px] max-w-full flex-col gap-6">
        <VnbotWordmark variant="wordmark" className="h-8 w-auto self-center" />
        <h1 className="text-center text-heading2 font-medium">
          <Trans>Tải VNBot</Trans>
        </h1>
        {failed ? (
          <p role="alert" className="text-center text-body text-muted-foreground">
            <Trans>Chưa tải được danh sách bản cài. Vui lòng thử lại sau.</Trans>
          </p>
        ) : (
          <SettingsGroup data-testid="desktop-downloads">
            {rows.map(([name, download]) =>
              download ? (
                <SettingsRow
                  key={name}
                  label={
                    <span>
                      <span className="block">{name}</span>
                      <span className="text-muted-foreground">{download.version}</span>
                    </span>
                  }
                  control={
                    <Button variant="outline" render={<a href={download.url} download />}>
                      <Trans>Tải về</Trans>
                    </Button>
                  }
                />
              ) : null,
            )}
          </SettingsGroup>
        )}
        <div className="flex flex-col gap-2">
          <p className="text-body text-muted-foreground">
            <Trans>Máy chủ Linux (Debian, Ubuntu): chạy lệnh này để cài hoặc cập nhật.</Trans>
          </p>
          <InputGroup>
            <InputGroupInput
              readOnly
              aria-label={t`Lệnh cài cho máy chủ Linux`}
              value={LINUX_SERVER_COMMAND}
              className="font-mono"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={t`Sao chép lệnh`}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(LINUX_SERVER_COMMAND)
                    .then(() => toast(t`Đã sao chép`))
                    .catch(() => undefined)
                }
              >
                <Copy />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
        <Button variant="ghost" className="self-center" render={<Link to="/app" />}>
          <Trans>Quay lại</Trans>
        </Button>
      </div>
    </main>
  );
}
