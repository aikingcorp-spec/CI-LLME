import { Trans } from "@lingui/react/macro";
import { Link, useNavigate } from "react-router-dom";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { VnbotMascotRow } from "../components/VnbotMascotRow";
import { VnbotWordmark } from "../components/VnbotWordmark";
import { WindowChrome } from "./WindowChrome";

const welcomePrimaryClass =
  "app-no-drag rounded-full bg-primary px-[34px] py-[15px] text-[19px] font-medium text-primary-foreground outline-none transition hover:scale-[1.04] hover:bg-primary-hover focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";
const welcomeLinkClass =
  "app-no-drag rounded-full px-[34px] py-[15px] text-[19px] font-medium text-link underline underline-offset-4 decoration-1 transition hover:decoration-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="welcome">
      <div className="app-drag flex items-center gap-2 px-5 py-[18px]">
        <WindowChrome />
        <LanguageSwitch className="ms-auto" />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-11 px-5 pb-[90px]">
        <h1>
          <VnbotWordmark variant="powered" className="h-16 w-auto sm:h-[104px]" />
        </h1>
        <p className="max-w-[600px] text-center text-[27px] leading-[1.4] text-foreground/75">
          <Trans>
            Your team of always-on bots
            <br />
            that you can give real work to.
          </Trans>
        </p>
        <VnbotMascotRow className="-my-4 flex gap-2 sm:gap-3.5" size="size-11 sm:size-16" />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/sign-in")}
            className={welcomePrimaryClass}
          >
            <Trans>Get started</Trans>
            <span aria-hidden="true">&nbsp;→</span>
          </button>
          <Link to="/sign-in" className={welcomeLinkClass}>
            <Trans>Sign in</Trans>
          </Link>
        </div>
      </main>
    </div>
  );
}
