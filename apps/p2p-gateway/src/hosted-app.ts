import { appContentSecurityPolicy } from "../../../packages/contracts/src/content-security-policy.js";

interface HostedAppEnv {
  ASSETS: Fetcher;
  /** Existing account service. Must trust the public app origin and issue host-only cookies. */
  AUTH_ORIGIN: string;
  P2P_GATEWAY_URL: string;
}
const AUTH_PATHS = new Set([
  "/api/auth/capabilities",
  "/api/auth/get-session",
  "/api/auth/sign-out",
  "/api/auth/email-otp/send-verification-otp",
  "/api/auth/sign-in/email-otp",
  "/api/auth/p2p-token",
]);

/** Only account traffic reaches the account service. Product traffic must use a data channel. */
export async function serveHostedApp(request: Request, env: HostedAppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.pathname.startsWith("/novnc")
  ) {
    if (!AUTH_PATHS.has(url.pathname)) return new Response("Not found", { status: 404 });
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" && request.method !== "POST")
      return new Response(null, { status: 405 });
    let upstream: URL;
    try {
      upstream = new URL(env.AUTH_ORIGIN);
      if (
        upstream.protocol !== "https:" ||
        upstream.origin === url.origin ||
        upstream.username ||
        upstream.password ||
        upstream.pathname !== "/" ||
        upstream.search ||
        upstream.hash
      )
        throw new Error("Invalid origin");
    } catch {
      return new Response("Account service is not configured", { status: 503 });
    }
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    const headers = new Headers();
    for (const name of ["content-type", "cookie", "authorization", "x-rakazo-locale"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    // The account deployment must configure its public auth URL as the hosted app origin.
    headers.set("origin", url.origin);
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    });
    // Auth endpoints used here are JSON only. Never redirect an OTP, cookie or token.
    if (response.status >= 300 && response.status < 400)
      return new Response("Account service redirect refused", { status: 502 });
    const out = new Response(response.body, response);
    out.headers.set("cache-control", "no-store");
    return out;
  }
  if (url.pathname.endsWith(".map")) return new Response(null, { status: 404 });
  const response = await env.ASSETS.fetch(request);
  const out = new Response(response.body, response);
  out.headers.set(
    "content-security-policy",
    appContentSecurityPolicy({ p2pGatewayUrl: env.P2P_GATEWAY_URL }),
  );
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "same-origin");
  if (out.headers.get("content-type")?.includes("text/html"))
    out.headers.set("cache-control", "no-cache");
  return out;
}
export default { fetch: serveHostedApp };
