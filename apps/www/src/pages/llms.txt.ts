import type { APIRoute } from "astro";
import { VNBOT_AGENT_INDEX } from "../vnbot-help";

export const GET: APIRoute = ({ request }) =>
  new Response(request.method === "HEAD" ? null : VNBOT_AGENT_INDEX, {
    headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Content-Language": "vi",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
