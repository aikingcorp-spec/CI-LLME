import { DOWNLOAD_URL } from "../src/site.js";

// Edge functions are bundled, which resolves the extensionless source imports.
export const config = { runtime: "edge" };

/** Redirects to the download page so the target can change without a site rebuild. */
export function fetchDownload(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: DOWNLOAD_URL,
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}

export function GET(): Response {
  return fetchDownload();
}
