import { afterEach, expect, it, vi } from "vitest";
import { browserConnection } from "./browser.js";

afterEach(() => vi.unstubAllGlobals());

it("preserves transient disconnection for the shared peer recovery lifecycle", () => {
  const peers: FixturePeer[] = [];
  class FixturePeer extends EventTarget {
    connectionState: RTCPeerConnectionState = "connected";
    constructor() {
      super();
      peers.push(this);
    }
  }
  vi.stubGlobal("RTCPeerConnection", FixturePeer);
  const transport = browserConnection({ iceServers: [] });
  const receive = vi.fn();
  transport.onStateChange(receive);
  const peer = peers[0];
  if (!peer) throw new Error("missing browser fixture");
  peer.connectionState = "disconnected";
  peer.dispatchEvent(new Event("connectionstatechange"));
  expect(receive).toHaveBeenLastCalledWith("disconnected");
  peer.connectionState = "connected";
  peer.dispatchEvent(new Event("connectionstatechange"));
  expect(receive).toHaveBeenLastCalledWith("connected");
});
