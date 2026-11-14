import { useLingui } from "@lingui/react/macro";
import type { PlanLimits, PlanLimitWindow } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";

const REFRESH_MS = 60_000;

/** Relative phrase such as "in 2 hours" or "5 minutes ago". */
function relativeTime(iso: string, locale: string, now: number): string | null {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return null;
  const seconds = Math.round((target - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

function WindowUsage({ window, now }: { window: PlanLimitWindow; now: number }) {
  const { t, i18n } = useLingui();
  const label =
    window.period === "session" ? t`Session` : window.period === "week" ? t`Weekly` : t`Monthly`;
  const used = Math.round(window.usedPercent);
  const reset = window.resetsAt ? relativeTime(window.resetsAt, i18n.locale, now) : null;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-body-sm">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{used}%</span>
      </div>
      <progress
        aria-label={t`${label}, ${used}% used`}
        value={used}
        max={100}
        className="mt-1.5 h-1.5 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
      />
      {reset ? (
        <p className="mt-1.5 truncate text-label text-muted-foreground">{t`Resets ${reset}`}</p>
      ) : null}
    </div>
  );
}

function PlanCard({ plan, now }: { plan: PlanLimits; now: number }) {
  const { t, i18n } = useLingui();
  const reading = plan.reading;
  const checked =
    reading.status === "unavailable" ? null : relativeTime(reading.checkedAt, i18n.locale, now);
  return (
    <div
      data-testid="plan-limits"
      data-status={reading.status}
      data-checked-at={reading.status === "unavailable" ? undefined : reading.checkedAt}
      className="px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body font-medium text-foreground">{plan.name}</span>
        {plan.label !== plan.name ? (
          <span className="min-w-0 truncate text-body-sm text-muted-foreground">{plan.label}</span>
        ) : null}
      </div>
      {reading.status === "unavailable" ? (
        <p className="mt-2 text-body-sm text-muted-foreground">{t`Couldn't read this account`}</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3">
          {reading.windows.map((window, index) => (
            <WindowUsage key={`${window.period}-${index}`} window={window} now={now} />
          ))}
        </div>
      )}
      {reading.status === "stale" && checked ? (
        <p className="mt-2 text-label text-muted-foreground">
          <time dateTime={reading.checkedAt}>{t`Last read ${checked}`}</time>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Per-account allowance windows on the Usage page. Mounted only while that
 * page is open, and refreshed once a minute while it stays visible.
 */
export function PlanUsage() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const query = useQuery({
    ...queries.usage.limits.queryOptions(),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });
  if (query.isPending && !query.data) {
    return (
      <p data-testid="plan-limits-loading" className="mb-3 text-body-sm text-muted-foreground">
        {t`Reading limits`}
      </p>
    );
  }
  if (query.isError) {
    return (
      <p data-testid="plan-limits-error" className="mb-3 text-body-sm text-muted-foreground">
        {t`Couldn't read limits`}
      </p>
    );
  }
  const plans = query.data ?? [];
  if (!plans.length) return null;
  const now = Date.now();
  return (
    <div
      data-testid="plan-usage"
      className="mb-3 divide-y divide-border rounded-xl border border-border"
    >
      {plans.map((plan) => (
        <PlanCard key={plan.credentialId} plan={plan} now={now} />
      ))}
    </div>
  );
}
