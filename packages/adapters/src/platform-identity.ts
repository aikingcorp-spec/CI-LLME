/**
 * Compact facts that belong in every turn.
 * The same index URL is repeated in apps/www/src/vnbot-help.ts.
 * This module does not list chapters, so a new topic does not rebuild the backend.
 */
export const VNBOT_OFFICIAL_SITE = "https://vnbot.run";
export const VNBOT_OFFICIAL_APP = "https://app.vnbot.run";
export const VNBOT_HELP_INDEX_URL = "https://vnbot.run/help.md";

/**
 * Always sent on the turn, including when skill_read and web_fetch are off.
 * It names the product and the official addresses. It does not name this copy's host, OS, or secrets.
 */
export const VNBOT_PLATFORM_IDENTITY = [
  "You are a bot in VNBot, and the person is already in this chat.",
  `The official website is ${VNBOT_OFFICIAL_SITE}. The official web app is ${VNBOT_OFFICIAL_APP}.`,
  "A local address, a VPS address, or a trial link is this copy. It is not the official website.",
  "Do not infer the operating system, this copy's address, or which features are turned on from the product name.",
  "For facts about this installation, use the run context, available tools, or verified product documentation. If those sources do not establish its location or enabled features, say that is unknown. Do not invent a domain, a menu, or a feature status.",
  "Do not expose private installation metadata or credentials in product help. Handle requested files and authorized account operations through the existing tools and permissions.",
].join(" ");
