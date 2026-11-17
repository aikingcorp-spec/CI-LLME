import { REMOTE_OFFLINE_AFTER_MS } from "@rakazo/core";
import { useEffect } from "react";
import { desktopBridge } from "../lib/desktop";
import { getRemoteEdition, setRemoteEdition } from "../lib/remote-edition";
import { rpc } from "../lib/rpc";

const PRESENCE_INTERVAL_MS = Math.floor(REMOTE_OFFLINE_AFTER_MS / 4);

/** While the desktop app is open, the pinned computer stays registered and present. */
export function LocalRemotePresence() {
  useEffect(() => {
    if (!desktopBridge()) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopTimer = () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const startTimer = () => {
      if (timer === undefined) {
        timer = setInterval(() => {
          void beat();
        }, PRESENCE_INTERVAL_MS);
      }
    };
    const beat = async () => {
      try {
        const portal = await rpc.remoteHosts?.list();
        if (!active) return;
        const edition = portal?.edition;
        setRemoteEdition(edition);
        if (edition === "free") stopTimer();
        else startTimer();
      } catch {
        // Keep current schedule on transient network failures.
      }
    };
    const onFocus = () => {
      if (getRemoteEdition() === "free") void beat();
    };
    startTimer();
    void beat();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      stopTimer();
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return null;
}
