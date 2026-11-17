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
  status: null as { subscription?: { modelCreditsMicros?: number } } | null,
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

vi.mock("./SubscriptionGate", () => ({
  useBilling: () => ({ status: limits.status }),
}));

vi.mock("../lib/query", () => ({
  useSpaceQueries: () => ({
    usage: {
      limits: {
        queryOptions: () => ({
          queryKey: ["usage", "limits"],
          queryFn: async () => {
            limits.calls += 1;
            if (limits.error) throw new Error("unavailable");
            return limits.plans;
          },
        }),
      },
    },
  }),
}));

const planA: PlanLimits = {
  credentialId: "c1",
  name: "Claude",
  label: "me@example.com",
  windows: [
    { period: "session", usedPercent: 38, resetsAt: "2026-11-13T14:00:00.000Z" },
    { period: "week", usedPercent: 64, resetsAt: null },
  ],
};
const planB: PlanLimits = {
  credentialId: "c2",
  name: "ChatGPT",
  label: "ChatGPT",
  windows: [{ period: "month", usedPercent: 93, resetsAt: null }],
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
  limits.status = null;
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

it("shows each account's usage windows", async () => {
  limits.plans = [planA, planB];
  await render();
  await settle();
  const cards = [...container.querySelectorAll("[data-testid=plan-limits]")];
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).toContain("Claude");
  expect(cards[0]?.textContent).toContain("me@example.com");
  expect(cards[0]?.textContent).toContain("38%");
  expect(cards[0]?.textContent).toContain("64%");
  expect(cards[1]?.textContent).toContain("ChatGPT");
  expect(cards[1]?.textContent).toContain("93%");
});

it("renders nothing when the member has no allowances or credits", async () => {
  await render();
  await settle();
  expect(container.querySelector("[data-testid=plan-limits]")).toBeNull();
  expect(container.querySelector("[data-testid=credit-balance]")).toBeNull();
});
