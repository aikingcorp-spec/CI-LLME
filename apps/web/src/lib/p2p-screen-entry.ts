import RFB from "@novnc/novnc";
import "./p2p-screen.css";

// This bundled, trusted frame receives only RFB bytes. It never receives node/account credentials.
let initialized = false;
window.addEventListener("message", (event) => {
  if (
    initialized ||
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.p2pScreen !== true ||
    !event.ports[0]
  )
    return;
  initialized = true;
  const port = event.ports[0];
  const report = (state: string) => parent.postMessage({ rakazoScreen: state }, location.origin);
  let pending = 0;
  let sending = false;
  const outgoing: Uint8Array[] = [];
  const raw = {
    readyState: 0,
    protocol: "binary",
    binaryType: "arraybuffer",
    onopen: () => {},
    onerror: (_error?: unknown) => {},
    onclose: (_event?: unknown) => {},
    onmessage: (_event: { data: ArrayBuffer }) => {},
    send(value: Uint8Array | ArrayBuffer) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (raw.readyState !== 1 || pending + bytes.length > 512 * 1024) {
        raw.close();
        return;
      }
      for (let i = 0; i < bytes.length; i += 16384) outgoing.push(bytes.slice(i, i + 16384));
      pending += bytes.length;
      flush();
    },
    close() {
      if (raw.readyState === 3) return;
      raw.readyState = 3;
      outgoing.length = 0;
      port.postMessage({ t: "close" });
      raw.onclose({ wasClean: true });
      port.close();
    },
  };
  function flush() {
    if (sending || raw.readyState !== 1) return;
    const bytes = outgoing.shift();
    if (!bytes) return;
    sending = true;
    pending -= bytes.length;
    port.postMessage({ t: "data", data: bytes.buffer }, [bytes.buffer]);
  }
  const rfb = new RFB(document.getElementById("screen")!, raw);
  rfb.viewOnly = event.data.viewOnly !== false;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.addEventListener("connect", () => report("connected"));
  rfb.addEventListener("disconnect", () => {
    report("disconnected");
    raw.close();
  });
  rfb.addEventListener("securityfailure", () => {
    report("failed");
    raw.close();
  });
  rfb.addEventListener("credentialsrequired", () => {
    report("failed");
    raw.close();
  });
  report("connecting");
  port.onmessage = ({ data }) => {
    if (data?.t === "open") {
      raw.readyState = 1;
      raw.onopen();
    } else if (
      data?.t === "data" &&
      data.data instanceof ArrayBuffer &&
      data.data.byteLength <= 16384
    ) {
      try {
        raw.onmessage({ data: data.data });
        port.postMessage({ t: "ack" });
      } catch {
        report("failed");
        raw.close();
      }
    } else if (data?.t === "ack") {
      sending = false;
      flush();
    } else if (data?.t === "close") {
      report("disconnected");
      raw.close();
    } else if (data?.t === "error") {
      report("failed");
      raw.close();
    }
  };
  window.addEventListener("message", (message) => {
    if (
      message.source === parent &&
      message.origin === location.origin &&
      message.data?.rakazoScreenFocus
    )
      rfb.focus();
  });
  window.addEventListener(
    "pagehide",
    () => {
      rfb.disconnect();
      raw.close();
    },
    { once: true },
  );
});
