import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { configuredEmailProvider as providerFor } from "@rakazo/adapters";
import type { AppEnv } from "./env.js";

/** Mailbox proof is required only when this process can deliver the message. */
export function verifiedEmailRequired(email: TransactionalEmailProvider | undefined): boolean {
  return email !== undefined;
}

export function configuredEmailProvider(
  env: Pick<AppEnv, "emailProvider" | "emailApiKey" | "emailFrom" | "emailReplyTo" | "smtpUrl">,
): TransactionalEmailProvider | undefined {
  return providerFor({
    provider: env.emailProvider,
    apiKey: env.emailApiKey,
    from: env.emailFrom,
    replyTo: env.emailReplyTo,
    smtpUrl: env.smtpUrl,
  });
}
