import { createRoot } from "react-dom/client";
import { ComputerScreenFrame } from "../src/components/ComputerScreenFrame";

let cleanup: (() => void) | undefined;
export function mountScreen() {
  const container = document.createElement("div");
  container.style.width = "360px";
  container.style.height = "240px";
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.zIndex = "10000";
  document.body.appendChild(container);
  const root = createRoot(container);
  const path = "/novnc/session/view/1234567890000.fixturefixturefixture/websockify";
  const url = new URL(path.replace("websockify", "vnc.html"), location.href);
  url.searchParams.set("path", "websockify");
  root.render(
    <ComputerScreenFrame
      title="P2P screen fixture"
      src={url.href}
      style={{ width: "100%", height: "100%" }}
    />,
  );
  cleanup = () => {
    root.unmount();
    container.remove();
  };
}
export function unmountScreen() {
  cleanup?.();
  cleanup = undefined;
}
