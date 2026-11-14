import { PRODUCT_DESKTOP_URL } from "../src/site.js";

// Edge functions are bundled, which resolves the extensionless source imports.
export const config = { runtime: "edge" };

/**
 * Every platform lands on the VNBot installer directory.
 * GitHub releases are not an approved install feed.
 */
export function fetchDownload(_request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: PRODUCT_DESKTOP_URL,
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}

export function GET(request: Request): Response {
  return fetchDownload(request);
}
