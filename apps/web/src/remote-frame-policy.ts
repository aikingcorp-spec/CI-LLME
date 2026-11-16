import {
  appContentSecurityPolicy,
  parseContentSecuritySources,
} from "@rakazo/contracts/content-security-policy";

/** Public policy from the configured API, never from a browser-supplied redirect or header. */
export async function portalFramePolicy(
  apiOrigin: string,
  requestHost: string | undefined,
  basePolicy: string,
  request: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await request(new URL("/api/remote-entry", apiOrigin), {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    if (!response.ok) return basePolicy;
    const entry: unknown = await response.json();
    if (
      !entry ||
      typeof entry !== "object" ||
      !("kind" in entry) ||
      entry.kind !== "portal" ||
      !("portalOrigin" in entry) ||
      typeof entry.portalOrigin !== "string" ||
      !("frameSrc" in entry) ||
      !Array.isArray(entry.frameSrc) ||
      !entry.frameSrc.every((value) => typeof value === "string")
    )
      return basePolicy;
    const portal = new URL(entry.portalOrigin);
    if (
      portal.protocol !== "https:" ||
      portal.origin !== entry.portalOrigin ||
      portal.host !== requestHost
    )
      return basePolicy;
    const frameSrc = parseContentSecuritySources("remote portal frames", entry.frameSrc.join(" "));
    const allowed = appContentSecurityPolicy({ frameSrc })
      .split(";")
      .find((value) => value.trim().startsWith("frame-src "))
      ?.trim();
    if (!allowed) return basePolicy;
    return basePolicy.replace(/frame-src\s+[^;]+/, allowed);
  } catch {
    return basePolicy;
  }
}
