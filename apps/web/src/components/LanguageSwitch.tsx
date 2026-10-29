import { useLingui } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web/lib/utils";
import { ChevronDown, Globe } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { getActiveUiLocale } from "../lib/i18n";
import { importChunk } from "../lib/preload-recovery";
import { UI_LOCALE_LABELS } from "../lib/ui-locale";

const loadMenu = () => importChunk(() => import("./LanguageSwitchMenu"));
const LanguageSwitchMenu = lazy(loadMenu);
const preloadMenu = () => void loadMenu().catch(() => undefined);

const triggerClass =
  "app-no-drag inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background ps-3 pe-2.5 text-[14px] font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * Compact vi/en picker for Welcome and AuthFrame (email-otp spec §6).
 * It renders a plain button and loads the Base UI menu on first use, so the
 * signed-out entry pages download no Base UI. It never submits a surrounding form.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t } = useLingui();
  const [armed, setArmed] = useState(false);
  const locale = getActiveUiLocale();
  const label = UI_LOCALE_LABELS[locale];
  const classes = cn(triggerClass, className);

  const button = (
    <button
      type="button"
      aria-label={t`Language: ${label}`}
      data-testid="language-switch"
      className={classes}
      onPointerEnter={preloadMenu}
      onFocus={preloadMenu}
      onClick={() => setArmed(true)}
    >
      <Globe aria-hidden="true" className="size-4 text-muted-foreground" />
      <span lang={locale}>{label}</span>
      <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
    </button>
  );

  if (!armed) return button;
  return (
    <Suspense fallback={button}>
      <LanguageSwitchMenu className={classes} />
    </Suspense>
  );
}
