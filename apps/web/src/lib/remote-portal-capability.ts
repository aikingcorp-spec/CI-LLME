import { useEffect, useState } from "react";
import { isRemotePortalHost } from "./remote-portal-host";

/** The same web build works on a staged portal and a native computer. */
export function useRemotePortal(): boolean | null {
  const official = isRemotePortalHost(window.location.hostname);
  const [portal, setPortal] = useState<boolean | null>(official ? true : null);
  useEffect(() => {
    if (official) return;
    let active = true;
    void fetch("/api/remote-entry")
      .then(async (response) => {
        const value: unknown = response.ok ? await response.json() : null;
        if (active)
          setPortal(
            Boolean(
              value && typeof value === "object" && "kind" in value && value.kind === "portal",
            ),
          );
      })
      .catch(() => {
        if (active) setPortal(false);
      });
    return () => {
      active = false;
    };
  }, [official]);
  return portal;
}
