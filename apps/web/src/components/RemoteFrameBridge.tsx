import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { remoteFramePage, setPinnedRemotePortalOrigin } from "../lib/remote-frame";

/** Only the local server's pinned portal may receive navigation, never cookies or tokens. */
export function RemoteFrameBridge({ authenticated }: { authenticated: boolean }) {
  const [portal, setPortal] = useState<string | null>(null);
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (window.parent === window) return;
    let active = true;
    void fetch("/api/remote-entry")
      .then(async (response) => {
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("portalOrigin" in value) ||
          typeof value.portalOrigin !== "string"
        )
          return;
        const url = new URL(value.portalOrigin);
        if (active && url.protocol === "https:" && url.origin === value.portalOrigin) {
          setPinnedRemotePortalOrigin(url.origin);
          setPortal(url.origin);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!portal) return;
    const path = pathname + search;
    if (authenticated && remoteFramePage(path))
      window.parent.postMessage({ type: "vnbot.remote.navigation", path }, portal);
    else if (!authenticated && pathname === "/sign-in")
      window.parent.postMessage({ type: "vnbot.remote.signed-out" }, portal);
  }, [portal, pathname, search, authenticated]);
  return null;
}
