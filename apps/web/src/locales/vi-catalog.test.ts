import { readFileSync } from "node:fs";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

// Only standalone brands, protocol names, and literal code tokens may stay untranslated.
const UNTRANSLATED = new Set([
  "VNBot",
  "API",
  "OAuth",
  "MCP",
  "URL",
  "JSON",
  "GitHub",
  "Slack",
  "Google",
  "Email",
  "Passkey",
  "OpenAI",
  "Anthropic",
  "Claude",
  "Gemini",
  "Ollama",
  "Honcho",
  "Mem0",
  "Telegram",
  "WhatsApp",
  "Discord",
  "Microsoft",
  "Notion",
  "Linear",
  "Docker",
  "Linux",
  "macOS",
  "Windows",
  "Android",
  "iOS",
  "HTTP",
  "HTTPS",
  "SSE",
  "WebSocket",
  "GB",
  "KB",
  "MB",
  "TB",
  "B",
  "Bot",
  "bot",
  "Cron",
  "Webhook",
  "Anthropic API",
  "OpenAI API",
  "Ollama Cloud",
  // Accessory names whose source text is already Vietnamese.
  "Áo dài",
  "Bánh chưng",
  "Khăn rằn",
  "Nón",
  "Sen",
  "ID",
  "JWT",
  "UTC",
  "SQL",
  "TypeScript",
  "JavaScript",
  "Python",
  "HTML",
  "CSS",
]);

it("has a Vietnamese translation for every catalog message", async () => {
  const catalog = await formatter().parse(
    readFileSync(new URL("./vi/messages.po", import.meta.url), "utf8"),
    { filename: "messages.po", locale: "vi", sourceLocale: "en" },
  );
  const missing = Object.entries(catalog).flatMap(([id, entry]) => {
    const source = entry.message || id;
    const translation = entry.translation?.trim();
    if (!translation) return [source];
    const literal = source.replace(/\{[^{}]*\}/gu, "").trim();
    if (!/\p{L}/u.test(literal) || UNTRANSLATED.has(literal)) return [];
    return translation === source.trim() ? [source] : [];
  });
  expect(missing, "Untranslated Vietnamese msgstr entries").toEqual([]);
});
