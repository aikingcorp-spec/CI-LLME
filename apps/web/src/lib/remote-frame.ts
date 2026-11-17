const DEVICE = /^[A-Za-z0-9_-]{1,256}$/;
const LOCAL_PAGE = /^\/(?:app(?:\/|$)|invite\/|onboarding(?:\/|$))/;

export function machinePath(deviceId: string, page = "/app"): string {
  if (!DEVICE.test(deviceId) || !remoteFramePage(page)) throw new Error("Invalid computer page");
  return `/m/${deviceId}${page}`;
}

export function machineDestination(value: string | null): string | null {
  if (!value) return null;
  const match = /^\/m\/([A-Za-z0-9_-]{1,256})(\/.*)$/.exec(value);
  return match && remoteFramePage(match[2]) ? value : null;
}

/** A host may report app navigation, never an external URL, auth endpoint or script. */
export function remoteFramePage(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || !LOCAL_PAGE.test(value)) return false;
  if (/[\\\r\n]/.test(value)) return false;
  const url = new URL(value, "https://local.invalid");
  return url.origin === "https://local.invalid" && LOCAL_PAGE.test(url.pathname);
}

export function frameEntry(
  href: string,
  invite?: string,
  page = "/app",
  portalOrigin?: string,
): { href: string; origin: string } {
  const url = new URL(href);
  if (
    url.protocol !== "https:" ||
    url.origin === portalOrigin ||
    url.username ||
    url.password ||
    url.pathname !== "/remote-enter" ||
    url.search ||
    !url.hash
  ) {
    throw new Error("Invalid computer entry");
  }
  if (!remoteFramePage(page)) throw new Error("Invalid computer page");
  url.hash = new URLSearchParams({
    ticket: url.hash.slice(1),
    next: page,
    ...(invite ? { invite } : {}),
  }).toString();
  return { href: url.href, origin: url.origin };
}

export function frameNavigation(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  expected: { origin: string; source: Window | null },
): string | null {
  if (!expected.source || event.source !== expected.source || event.origin !== expected.origin)
    return null;
  const data: unknown = event.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    data.type !== "vnbot.remote.navigation" ||
    !("path" in data)
  )
    return null;
  return remoteFramePage(data.path) ? data.path : null;
}

export function pendingFrameInvite(deviceId: string, incoming?: string): string | undefined {
  try {
    const key = "rakazo.remoteFrameInvite";
    if (incoming) sessionStorage.setItem(key, JSON.stringify({ deviceId, invite: incoming }));
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "deviceId" in value &&
      value.deviceId === deviceId &&
      "invite" in value &&
      typeof value.invite === "string"
    )
      return value.invite;
  } catch {
    /* Private browsing may deny session storage. The current entry still works. */
  }
  return incoming;
}

export function clearPendingFrameInvite(): void {
  try {
    sessionStorage.removeItem("rakazo.remoteFrameInvite");
  } catch {
    /* Storage is optional. */
  }
}

let pinnedPortalOrigin: string | null = null;

export function setPinnedRemotePortalOrigin(origin: string | null): void {
  pinnedPortalOrigin = origin;
}

export function isInsideRemoteFrame(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

/** Asks the pinned central portal frame to return to its host picker without signing out. */
export async function requestRemoteHostSwitch(): Promise<boolean> {
  if (!isInsideRemoteFrame()) return false;
  let origin = pinnedPortalOrigin;
  if (!origin) {
    try {
      const response = await fetch("/api/remote-entry");
      if (response.ok) {
        const value: unknown = await response.json();
        if (
          value &&
          typeof value === "object" &&
          "portalOrigin" in value &&
          typeof value.portalOrigin === "string"
        ) {
          const url = new URL(value.portalOrigin);
          if (url.protocol === "https:" && url.origin === value.portalOrigin) {
            origin = url.origin;
            pinnedPortalOrigin = origin;
          }
        }
      }
    } catch {
      /* Ignore lookup failure; caller can fall back. */
    }
  }
  if (!origin) return false;
  window.parent.postMessage({ type: "vnbot.remote.switch-host" }, origin);
  return true;
}
