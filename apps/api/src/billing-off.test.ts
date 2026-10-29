import type { BillingProvider } from "@rakazo/adapter-kit";
import { stripeBillingConfigFromEnv } from "@rakazo/adapters";
import { describe, expect, it, vi } from "vitest";
import { vnbotBillingProvider } from "./billing-off.js";
import { loadEnv } from "./env.js";

describe("VNBot billing stays off", () => {
  it("ignores STRIPE_* so no paid plan or credit checkout is ever wired", () => {
    const env = loadEnv({
      ...process.env,
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db",
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_fake",
      STRIPE_PRICE_ID: "price_fake",
    });
    const warn = vi.fn();
    expect(vnbotBillingProvider(undefined, Boolean(stripeBillingConfigFromEnv(env)), warn)).toBe(
      undefined,
    );
    expect(warn).toHaveBeenCalledWith("STRIPE_* is set but ignored: VNBot billing is off");
  });

  it("starts quietly without STRIPE_*", () => {
    const warn = vi.fn();
    expect(vnbotBillingProvider(undefined, false, warn)).toBe(undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still accepts an explicit test override", () => {
    const provider = { describe: () => ({ id: "emulator" }) } as unknown as BillingProvider;
    expect(vnbotBillingProvider(provider, true, vi.fn())).toBe(provider);
  });
});
