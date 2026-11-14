import type { APIRoute } from "astro";
import { vnbotHelpIndexMarkdown, vnbotMarkdownResponse } from "../vnbot-help";

export const GET: APIRoute = ({ request }) =>
  vnbotMarkdownResponse(vnbotHelpIndexMarkdown(), request.method);
