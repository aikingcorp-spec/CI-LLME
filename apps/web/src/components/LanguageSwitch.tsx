import { useLingui } from "@lingui/react/macro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web/components/ui/dropdown-menu";
import { cn } from "@rakazo/ui-web/lib/utils";
import { ChevronDown, Globe } from "lucide-react";
import { useRef, useState } from "react";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import type { UiLocale } from "../lib/ui-locale";
import { PICKER_LOCALES, UI_LOCALE_LABELS } from "../lib/ui-locale";

/** Share the same choices across web language pickers. */
export const LANGUAGE_SWITCH_LOCALES = PICKER_LOCALES;
type SwitchLocale = (typeof LANGUAGE_SWITCH_LOCALES)[number];

function isSwitchLocale(value: unknown): value is SwitchLocale {
  return (LANGUAGE_SWITCH_LOCALES as readonly unknown[]).includes(value);
}

/**
 * Compact vi/en picker for Welcome and AuthFrame (email-otp spec §6).
 * Same functions as Settings: optimistic state, and a request id so the last click wins.
 * It renders a plain button, so inside a form it never submits.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t } = useLingui();
  const [locale, setLocale] = useState<UiLocale>(() => getActiveUiLocale());
  const requestRef = useRef(0);
  const label = UI_LOCALE_LABELS[locale];

  function choose(next: UiLocale) {
    if (next === locale) return;
    const requestId = ++requestRef.current;
    setLocale(next);
    void setUiLocale(next).then((activated) => {
      if (requestId !== requestRef.current) return;
      setLocale(activated);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label={t`Language: ${label}`}
        data-testid="language-switch"
        className={cn(
          "app-no-drag inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-background ps-3 pe-2.5 text-[14px] font-medium text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        <Globe aria-hidden="true" className="size-4 text-muted-foreground" />
        <span lang={locale}>{label}</span>
        <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-auto min-w-[184px] rounded-xl border border-border bg-popover p-1 shadow-lg"
      >
        <DropdownMenuRadioGroup
          value={isSwitchLocale(locale) ? locale : undefined}
          onValueChange={(value: unknown) => {
            if (isSwitchLocale(value)) choose(value);
          }}
        >
          {LANGUAGE_SWITCH_LOCALES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              lang={option}
              closeOnClick
              className="h-9 rounded-lg px-2.5 text-[14px] data-highlighted:bg-accent data-checked:font-medium [&_[data-slot=dropdown-menu-radio-item-indicator]_svg]:text-primary"
            >
              {UI_LOCALE_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
