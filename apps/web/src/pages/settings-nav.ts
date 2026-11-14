import { useLingui } from "@lingui/react/macro";
import {
  Brain,
  CloudDownload,
  Cpu,
  CreditCard,
  Gauge,
  KeyRound,
  MessageCircle,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  Wallet,
} from "lucide-react";
import type { ComponentType } from "react";
import type { SettingsSection } from "./shell-overlay";

export type SettingsNavItem = {
  id: SettingsSection;
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** One line under the page title, only where the name alone does not say what the page is for. */
  description?: string;
};

/** The settings sections this deployment offers, in nav order; Space opens from its own menu. */
export function useSettingsNavItems(available: {
  messaging: boolean;
  wallet: boolean;
  computer: boolean;
  billing: boolean;
  updates: boolean;
}): SettingsNavItem[] {
  const { t } = useLingui();
  return [
    // VNBot keeps the 0.3.9 order; pages it did not have sit next to their closest neighbour.
    { id: "general", label: t`General`, icon: Settings },
    { id: "connection", label: t`Kết nối`, icon: Monitor },
    { id: "models", label: t`Models`, icon: Cpu, description: t`Which LLMs your bots use.` },
    {
      id: "voice",
      label: t`Voice`,
      icon: Volume2,
      description: t`Calls, dictation, and replies read aloud.`,
    },
    {
      id: "confirmations",
      label: t`Approvals`,
      icon: ShieldCheck,
      description: t`When bots check with you before acting.`,
    },
    {
      id: "vault",
      label: t`Vault`,
      icon: KeyRound,
      description: t`Logins and keys your bots can use.`,
    },
    ...(available.wallet
      ? [
          {
            id: "wallet" as const,
            label: t`Wallet`,
            icon: Wallet,
            description: t`Where your bots pay from.`,
          },
        ]
      : []),
    // Listed before a provider is mounted, so Telegram and Slack are findable.
    // `available.messaging` stays on the argument for callers and does not hide this item.
    {
      id: "messaging",
      label: t`Messaging`,
      icon: MessageCircle,
      description: t`Chat with your bots from other apps.`,
    },
    {
      id: "memory",
      label: t`Memory`,
      icon: Brain,
      description: t`What your bots remember between chats.`,
    },
    { id: "usage", label: t`Usage`, icon: Gauge },
    ...(available.computer
      ? [
          {
            id: "computer" as const,
            label: t`Computer`,
            icon: Monitor,
            description: t`The computer your bots work on.`,
          },
        ]
      : []),
    ...(available.billing ? [{ id: "billing" as const, label: t`Billing`, icon: CreditCard }] : []),
    // VNBot hides Organization: each account works in one. The panel stays for later.
    // Docker and the browser have no desktop bridge, and this item is still the way in.
    { id: "updates", label: t`Updates`, icon: CloudDownload },
  ];
}
