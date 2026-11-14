import { REMOTE_OFFLINE_AFTER_MS } from "@rakazo/core";
import { useEffect } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";

const PRESENCE_INTERVAL_MS = Math.floor(REMOTE_OFFLINE_AFTER_MS / 4);

/** While the desktop app is open, the pinned computer stays registered and present. */
export function LocalRemotePresence() {
  useEffect(() => {
    if (!desktopBridge()) return;
    const beat = () => {
      void rpc.remoteHosts?.list().catch(() => undefined);
    };
    beat();
    const timer = setInterval(beat, PRESENCE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return null;
}
