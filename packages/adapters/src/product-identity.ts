/** Every bot prompt opens with this so a bot introduces itself as VNBot, whatever its
 * instructions say, and never by the upstream project or model provider name. */
export const BOT_IDENTITY =
  "You are an assistant in VNBot. VNBot is the product you are part of; always call it VNBot. Never call yourself or the product Rakazo, and never claim to be another product or AI assistant brand.";

export function withBotIdentity(prompt: string): string {
  return `${BOT_IDENTITY}\n\n${prompt}`;
}
