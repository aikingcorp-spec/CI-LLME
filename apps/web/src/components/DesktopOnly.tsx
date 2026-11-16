import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { useSignOut } from "../lib/sign-out";
import { VNBOT_DOWNLOAD_URL } from "../lib/vnbot-links";
import { VnbotWordmark } from "./VnbotWordmark";

/** A free account signed in to the hosted web app, which only team accounts use. */
export function DesktopOnlyPage() {
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut("/sign-in", setLogoutError);
  return (
    <main className="grid h-full place-items-center bg-background px-6 text-center text-foreground">
      <div className="flex w-[460px] max-w-full flex-col items-center">
        <VnbotWordmark variant="wordmark" className="h-8 w-auto sm:h-9" />
        <h1 className="mt-7 text-heading2 text-balance">
          <Trans>Use VNBot on your computer</Trans>
        </h1>
        <p className="mt-3 text-body text-pretty text-muted-foreground">
          <Trans>Your account works in the VNBot app, not on the web.</Trans>
        </p>
        <Button className="mt-8" render={<a href={VNBOT_DOWNLOAD_URL} />}>
          <Trans>Download VNBot</Trans>
        </Button>
        <Button
          variant="ghost"
          className="mt-2"
          disabled={signingOut}
          onClick={() => void logOut()}
        >
          <Trans>Log out</Trans>
        </Button>
        {logoutError ? (
          <p role="alert" className="mt-3 text-body text-destructive">
            {logoutError}
          </p>
        ) : null}
      </div>
    </main>
  );
}
