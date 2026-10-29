export type VsPoints = {
  rakazo: readonly string[];
  other: readonly string[];
};

/**
 * Short card lines. Each one is a compression of the comparison already on that
 * page, not a new claim.
 */
export const VS_CARDS: Record<string, VsPoints> = {
  "muse-alternative": {
    rakazo: ["You host it", "You bring the model", "No seat fee"],
    other: ["Meta hosts it", "Muse Spark", "Muse app and WhatsApp"],
  },
  "dots-alternative": {
    rakazo: ["You host it", "Any supported model", "No seat fee"],
    other: ["OpenAI hosts it", "Eligible ChatGPT plans", "Not self-hosted"],
  },
  "grok-bot-alternative": {
    rakazo: ["You host it", "You bring the model", "No seat fee"],
    other: ["xAI hosts it", "Paid Cursor and SuperGrok", "Not self-hosted"],
  },
  "openclaw-alternative": {
    rakazo: ["Chat in the VNBot app", "Desktop app, then chat", "No seat fee"],
    other: ["Gateway for chat apps", "CLI, onboarding, config file", "No software fee"],
  },
  "hermes-alternative": {
    rakazo: ["Chat in the VNBot app", "Desktop app, then chat", "No seat fee"],
    other: ["Desktop app and a CLI", "Config under ~/.hermes", "No software fee"],
  },
  "instinct-alternative": {
    rakazo: ["You host it", "You bring the model", "No seat fee"],
    other: ["Hosted assistant", "Text or call", "Not self-hosted"],
  },
  "claude-duet-alternative": {
    rakazo: ["You host it", "Claude or any supported model", "No seat fee"],
    other: ["Anthropic hosts it", "Claude Pro and Max, US only", "Not self-hosted"],
  },
  "hark-alternative": {
    rakazo: ["You host it", "You bring the model", "No seat fee"],
    other: ["Hark hosts it", "Free, with paid usage tiers", "Not self-hosted"],
  },
};

export function vsCard(slug: string): VsPoints | undefined {
  return VS_CARDS[slug];
}
