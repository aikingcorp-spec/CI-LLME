import { expect, test } from "@playwright/test";
import type { PlanLimits, UsageSummary } from "@rakazo/contracts";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

const checkedAt = "2026-11-13T12:00:00.000Z";
const hours = (count: number) => new Date(Date.now() + count * 3_600_000).toISOString();

const plans: PlanLimits[] = [
  {
    credentialId: "claude",
    name: "Claude",
    label: "me@example.com",
    reading: {
      status: "fresh",
      checkedAt,
      windows: [
        { period: "session", usedPercent: 38, resetsAt: hours(2.5) },
        { period: "week", usedPercent: 64, resetsAt: hours(80) },
      ],
    },
  },
  {
    credentialId: "chatgpt",
    name: "ChatGPT",
    label: "work@example.com",
    reading: {
      status: "stale",
      checkedAt,
      windows: [{ period: "session", usedPercent: 93, resetsAt: hours(0.4) }],
    },
  },
  {
    credentialId: "other",
    name: "Claude",
    label: "other@example.com",
    reading: { status: "unavailable" },
  },
];

const summary: UsageSummary = {
  runs: 4,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  costUsd: 0.2,
  modelCalls: 4,
  models: [
    {
      provider: "subscription",
      model: "example-large",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.2,
      modelCalls: 4,
    },
  ],
};

test("Usage keeps token totals and shows each account's allowance", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "en"));
  await page.route("**/rpc/usage/limits", (route) => route.fulfill({ json: { json: plans } }));
  await page.route("**/rpc/usage/summary", (route) => route.fulfill({ json: { json: summary } }));
  const stamp = Date.now();
  await signup(page, `usage-limits-${stamp}@example.test`, "password12", "Usage limits");
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menuUsage = page.getByRole("button", { name: "Usage", exact: true });
  await expect(menuUsage).toBeVisible();
  await expect(menuUsage).not.toContainText("%");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page, "usage");
  await expect(settings).toHaveAttribute("data-settings-section", "usage");
  const cards = settings.getByTestId("plan-limits");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).getByRole("progressbar", { name: "Weekly, 64% used" })).toHaveAttribute(
    "value",
    "64",
  );
  await expect(cards.nth(1)).toContainText("Last read");
  await expect(cards.nth(1)).toContainText("93%");
  await expect(cards.nth(2)).toContainText("Couldn't read this account");
  await expect(cards.nth(2).getByRole("progressbar")).toHaveCount(0);
  await expect(settings.getByText("example-large")).toBeVisible();
  await expect(settings.getByText("120")).toBeVisible();
  await captureScreenshot(page, testInfo, "usage-plan-limits");
});
