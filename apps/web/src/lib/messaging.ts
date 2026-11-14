import { messagingProviderLabel, messagingProviderName } from "@rakazo/core";

/** User-facing name of a messaging provider (falls back to the raw id). */
export const providerLabel = messagingProviderName;

/** Per-message provider label, narrowed to a recognized transport when available. */
export const messageProviderLabel = messagingProviderLabel;

export type ChatAppKind = "unknown" | "absent" | "ready";

export type MessagingConnectionState = "unconfigured" | "starting" | "ready" | "error";

/** Which controls a saved connection may show. Ready is the only state with Replace. */
export function messagingConnectionControl(connection: {
  configured: boolean;
  state: MessagingConnectionState;
  canConfigure: boolean;
}): {
  status: MessagingConnectionState;
  showCredentialField: boolean;
  showRemove: boolean;
  showReplace: boolean;
} {
  const editable = connection.canConfigure;
  return {
    status: connection.state,
    showCredentialField:
      editable && (connection.state === "unconfigured" || connection.state === "error"),
    showRemove: editable && connection.configured && connection.state !== "starting",
    showReplace: editable && connection.state === "ready",
  };
}

/** What the settings page may say before it invents a connect action. */
export type ChatAppRead =
  | { status: "pending" }
  | {
      status: "status-only";
      providers: readonly string[];
      identityProviders: readonly string[];
    }
  | {
      status: "settled";
      providers: readonly string[];
      identityProviders: readonly string[];
      slackInstallAvailable: boolean;
      slackInstallationCount: number;
    };

/** Query flags stay at the edge. A failed install read cannot look settled. */
export function chatAppRead(input: {
  statusReady: boolean;
  providers: readonly string[];
  identityProviders: readonly string[];
  installationsReady: boolean;
  slackInstallAvailable: boolean;
  slackInstallationCount: number;
}): ChatAppRead {
  if (!input.statusReady) return { status: "pending" };
  if (!input.installationsReady) {
    return {
      status: "status-only",
      providers: input.providers,
      identityProviders: input.identityProviders,
    };
  }
  return {
    status: "settled",
    providers: input.providers,
    identityProviders: input.identityProviders,
    slackInstallAvailable: input.slackInstallAvailable,
    slackInstallationCount: input.slackInstallationCount,
  };
}

function telegramMounted(providers: readonly string[]): boolean {
  return providers.some((provider) => provider === "telegram" || provider.startsWith("telegram-"));
}

function slackMounted(providers: readonly string[], identityProviders: readonly string[]): boolean {
  return providers.includes("slack") || identityProviders.includes("slack");
}

/** Telegram and Slack each have one kind. Ready means the existing controls own that app. */
export function chatAppSetup(read: ChatAppRead): { telegram: ChatAppKind; slack: ChatAppKind } {
  switch (read.status) {
    case "pending":
      return { telegram: "unknown", slack: "unknown" };
    case "status-only":
      return {
        telegram:
          telegramMounted(read.providers) || telegramMounted(read.identityProviders)
            ? "ready"
            : "absent",
        slack: slackMounted(read.providers, read.identityProviders) ? "ready" : "unknown",
      };
    case "settled":
      return {
        telegram:
          telegramMounted(read.providers) || telegramMounted(read.identityProviders)
            ? "ready"
            : "absent",
        slack:
          slackMounted(read.providers, read.identityProviders) ||
          read.slackInstallAvailable ||
          read.slackInstallationCount > 0
            ? "ready"
            : "absent",
      };
    default: {
      const _exhaustive: never = read;
      return _exhaustive;
    }
  }
}
