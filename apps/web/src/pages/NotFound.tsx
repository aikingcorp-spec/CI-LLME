import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

/** VNBot 0.3.9 not-found page; the window chrome keeps the desktop window movable and closable. */
export function NotFoundPage() {
  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="not-found">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <main className="grid flex-1 place-content-center gap-3 text-center">
        <h1>
          <Trans>Page not found</Trans>
        </h1>
        <Link
          to="/app"
          className="app-no-drag text-link underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
        >
          <Trans>Go home</Trans>
        </Link>
      </main>
    </div>
  );
}
