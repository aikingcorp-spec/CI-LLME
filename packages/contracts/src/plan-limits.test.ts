import { describe, expect, it } from "vitest";
import { PlanLimitReadingSchema, PlanLimitsSchema } from "./domain.js";

const window = {
  period: "session" as const,
  usedPercent: 42,
  resetsAt: "2026-11-10T15:00:00.000Z",
};
const checkedAt = "2026-11-10T12:00:00.000Z";

describe("PlanLimitReadingSchema", () => {
  it("accepts a fresh or stale reading only when the percent has a real read time", () => {
    expect(
      PlanLimitReadingSchema.parse({ status: "fresh", checkedAt, windows: [window] }),
    ).toMatchObject({ status: "fresh", checkedAt });
    expect(
      PlanLimitReadingSchema.parse({ status: "stale", checkedAt, windows: [window] }),
    ).toMatchObject({ status: "stale", checkedAt, windows: [window] });
    expect(PlanLimitReadingSchema.safeParse({ status: "fresh", windows: [window] }).success).toBe(
      false,
    );
    expect(
      PlanLimitReadingSchema.safeParse({ status: "stale", checkedAt, windows: [] }).success,
    ).toBe(false);
  });

  it("rejects an unavailable reading that smuggles a percent", () => {
    const parsed = PlanLimitReadingSchema.parse({ status: "unavailable" });
    expect(parsed).toEqual({ status: "unavailable" });
    expect(parsed).not.toHaveProperty("usedPercent");
    expect(parsed).not.toHaveProperty("windows");
    expect(
      PlanLimitReadingSchema.safeParse({ status: "unavailable", usedPercent: 0, windows: [window] })
        .success,
    ).toBe(false);
    expect(
      PlanLimitReadingSchema.safeParse({
        status: "fresh",
        checkedAt,
        windows: [{ ...window, usedPercent: 101 }],
      }).success,
    ).toBe(false);
  });
});

describe("PlanLimitsSchema", () => {
  it("links windows to a credential without a provider field", () => {
    const plan = PlanLimitsSchema.parse({
      credentialId: "cred-1",
      name: "Claude",
      label: "me@example.com",
      reading: { status: "fresh", checkedAt, windows: [window] },
    });
    expect(plan.credentialId).toBe("cred-1");
    expect(plan).not.toHaveProperty("provider");
    expect(Object.keys(plan).sort()).toEqual(["credentialId", "label", "name", "reading"]);
  });
});
