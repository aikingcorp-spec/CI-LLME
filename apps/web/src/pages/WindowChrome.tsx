import { desktopBridge, windowChromeKind } from "../lib/desktop";

export function WindowChrome() {
  const desktop = desktopBridge();
  const kind = windowChromeKind(desktop);
  if (kind === "spacer") {
    return <div className="h-3 w-[72px]" aria-hidden="true" />;
  }
  if (kind === "darwin") {
    return <div className="app-drag h-3 w-[72px]" aria-hidden="true" />;
  }
  return null;
}
