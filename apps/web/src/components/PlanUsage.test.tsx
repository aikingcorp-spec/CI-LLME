// @vitest-environment jsdom

import type { PlanLimits } from "@rakazo/contracts";
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanUsage } from "./PlanUsage";

const limits = vi.hoisted(() => ({
  plans: [] as PlanLimits[],
  error: false,
  calls: 0,
  pending: null as Promise<PlanLimits[]> | null,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => text + (index ? String(values[index - 1]) : "") + part,
        "",
      ),
    i18n: { locale: "en" },
  }),
}));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    usage: {
      limits: {
        queryOptions: () => ({
          queryKey: ["usage", "limits"],
          queryFn: async () => {
            limits.calls += 1;
            if (limits.pending) return limits.pending;
            if (limits.error) throw new Error("unavailable");
            return limits.plans;
          },
        }),
      },
    },
  }),
}));

const checkedAt = "2026-11-13T11:55:00.000Z";
const fresh: PlanLimits = {
  credentialId: "c1",
  name: "Claude",
  label: "me@example.com",
  reading: {
    status: "fresh",
    checkedAt,
    windows: [
      { period: "session", usedPercent: 38, resetsAt: "2026-11-13T14:00:00.000Z" },
      { period: "week", usedPercent: 64, resetsAt: null },
    ],
  },
};
const stale: PlanLimits = {
  credentialId: "c2",
  name: "ChatGPT",
  label: "work@example.com",
  reading: {
    status: "stale",
    checkedAt,
    windows: [{ period: "session", usedPercent: 93, resetsAt: null }],
  },
};
const unavailable: PlanLimits = {
  credentialId: "c3",
  name: "Claude",
  label: "other@example.com",
  reading: { status: "unavailable" },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  notifyManager.setScheduler((callback) => {
    callback();
  });
  limits.plans = [];
  limits.error = false;
  limits.calls = 0;
  limits.pending = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  notifyManager.setScheduler(defaultScheduler);
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PlanUsage />
      </QueryClientProvider>,
    );
  });
  return client;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("shows each account's windows and keeps an unavailable account off 0%", async () => {
  limits.plans = [fresh, stale, unavailable];
  await render();
  await settle();
  const cards = [...container.querySelectorAll("[data-testid=plan-limits]")];
  expect(cards).toHaveLength(3);
  expect(cards[0]?.textContent).toContain("Claude");
  expect(cards[0]?.textContent).toContain("me@example.com");
  expect(cards[0]?.getAttribute("data-status")).toBe("fresh");
  expect(cards[0]?.getAttribute("data-checked-at")).toBe(checkedAt);
  const bars = [...(cards[0]?.querySelectorAll("progress") ?? [])] as HTMLProgressElement[];
  expect(bars[0]?.value).toBe(38);
  expect(bars[0]?.getAttribute("aria-label")).toBe("Session, 38% used");
  expect(bars[1]?.value).toBe(64);
  expect(cards[0]?.textContent).not.toContain("Last read");
  expect(cards[1]?.textContent).toContain("Last read");
  expect(cards[1]?.querySelector("time")?.getAttribute("dateTime")).toBe(checkedAt);
  expect(cards[1]?.textContent).toContain("93%");
  expect(cards[2]?.textContent).toContain("Couldn't read this account");
  expect(cards[2]?.querySelector("progress")).toBeNull();
  expect(cards[2]?.textContent).not.toContain("0%");
  expect(container.textContent).not.toContain("50%");
});

it("shows a loading line, then nothing when the member has no allowances", async () => {
  let release: (plans: PlanLimits[]) => void = () => undefined;
  limits.pending = new Promise((resolve) => {
    release = resolve;
  });
  await render();
  expect(container.querySelector("[data-testid=plan-limits-loading]")?.textContent).toContain(
    "Reading limits",
  );
  limits.pending = null;
  await act(async () => {
    release([]);
  });
  expect(container.querySelector("[data-testid=plan-usage]")).toBeNull();
  expect(container.querySelector("progress")).toBeNull();
  expect(container.textContent).not.toContain("0%");
});

it("shows a failed read without a zero bar", async () => {
  limits.error = true;
  await render();
  await settle();
  expect(container.querySelector("[data-testid=plan-limits-error]")?.textContent).toContain(
    "Couldn't read limits",
  );
  expect(container.querySelector("progress")).toBeNull();
  expect(container.textContent).not.toContain("0%");
});

it("refreshes the open page on the one minute interval", async () => {
  vi.useFakeTimers();
  limits.plans = [fresh];
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.textContent).toContain("38%");
  const calls = limits.calls;
  limits.plans = [
    {
      ...fresh,
      reading: {
        status: "fresh",
        checkedAt: "2026-11-13T12:00:00.000Z",
        windows: [{ period: "session", usedPercent: 80, resetsAt: null }],
      },
    },
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(limits.calls).toBeGreaterThan(calls);
  expect(container.textContent).toContain("80%");
  expect(container.textContent).not.toContain("64%");
});

it("does not present old numbers as fresh after an API refetch fails", async () => {
  vi.useFakeTimers();
  limits.plans = [fresh];
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(container.querySelector("progress")).not.toBeNull();
  limits.error = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(container.querySelector("[data-testid=plan-limits-error]")).not.toBeNull();
  expect(container.querySelector("progress")).toBeNull();
});
