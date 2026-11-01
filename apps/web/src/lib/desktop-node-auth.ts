import { useEffect, useState } from "react";
import { desktopBridge } from "./desktop";

/** Existing-server desktop windows keep their own HTTP sign-in. Only the owned node uses OTP IPC. */
export function useDesktopNodeAuth() {
  const [local, setLocal] = useState(false);
  useEffect(() => {
    let active = true;
    const bridge = desktopBridge()?.p2p;
    if (bridge)
      void bridge
        .isLocal()
        .then((value) => {
          if (active) setLocal(value);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return local ? desktopBridge()?.p2p : undefined;
}
