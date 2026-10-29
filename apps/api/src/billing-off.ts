import type { BillingProvider } from "@rakazo/adapter-kit";

/** VNBot has no paywall (PRODUCT.md): every current feature is free, so STRIPE_* never turns on
 * paid plans or model credits. Only an explicit override (tests) wires a billing provider. */
export function vnbotBillingProvider(
  override: BillingProvider | undefined,
  stripeConfigured: boolean,
  warn: (message: string) => void,
): BillingProvider | undefined {
  if (stripeConfigured && !override) warn("STRIPE_* is set but ignored: VNBot billing is off");
  return override;
}
