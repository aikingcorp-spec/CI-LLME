import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { IceServer } from "node-datachannel";
import type { RTCDataChannel } from "werift";
import { RTCPeerConnection } from "werift";
import type { PeerChannel, PeerTransport, PeerTransportConfig } from "./webrtc-peer.js";

/**
 * Test-only ICE/DTLS/SCTP stack that can reach a TURN server over TCP or TLS. node-datachannel
 * (libjuice) only gathers relay candidates over UDP, so a TURN/TCP or TURNS proof needs werift.
 * Nothing in production imports this module.
 */

export type TurnClientTransport = "udp" | "tcp" | "tls";

const TURN_URL_SCHEME = { TurnUdp: "turn", TurnTcp: "turn", TurnTls: "turns" } as const;
const TURN_URL_TRANSPORT = { TurnUdp: "udp", TurnTcp: "tcp", TurnTls: "tcp" } as const;

/** Maps TURN servers to the URL form werift parses (`turns:` selects TLS). werift uses the first one. */
export function weriftIceServers(
  servers: PeerTransportConfig["iceServers"],
): Array<{ urls: string; username: string; credential: string }> {
  return servers.map((server) => {
    if (typeof server === "string") throw new Error("werift needs IceServer objects, not strings");
    const { hostname, port, username, password, relayType = "TurnUdp" } = server as IceServer;
    if (!username || !password) throw new Error("TURN server needs a username and a credential");
    return {
      urls: `${TURN_URL_SCHEME[relayType]}:${hostname}:${port}?transport=${TURN_URL_TRANSPORT[relayType]}`,
      username,
      credential: password,
    };
  });
}

/**
 * TLS options for a TURNS server with a self-signed certificate. `TURN_TLS_CA_FILE` pins that
 * certificate as the only trust anchor; the hostname is not checked because the peers may reach
 * the server through an address-level forwarder. Without the file the default verification stays on.
 */
export function turnTlsOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ConnectionOptions {
  if (!env.TURN_TLS_CA_FILE) return {};
  return {
    ca: readFileSync(env.TURN_TLS_CA_FILE, "utf8"),
    checkServerIdentity: () => undefined,
  };
}

class WeriftChannel implements PeerChannel {
  constructor(private readonly dc: RTCDataChannel) {}
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.dc.onMessage.subscribe((msg) => cb(msg));
  }
  onClosed(cb: () => void): void {
    this.dc.stateChanged.subscribe((state) => {
      if (state === "closed") cb();
    });
  }
  onOpen(cb: () => void): void {
    this.dc.stateChanged.subscribe((state) => {
      if (state === "open") cb();
    });
  }
  isOpen(): boolean {
    return this.dc.readyState === "open";
  }
  sendMessage(msg: string): boolean {
    this.dc.send(msg);
    return true;
  }
  sendMessageBinary(buffer: Uint8Array): boolean {
    this.dc.send(Buffer.from(buffer));
    return true;
  }
  close(): void {
    this.dc.close();
  }
}

/** Presents werift's RTCPeerConnection as the node-datachannel callback API that connectPeer drives. */
export class WeriftPeerConnection implements PeerTransport {
  private readonly pc: RTCPeerConnection;
  private localDescriptionCb: (sdp: string, type: string) => void = () => {};
  private localCandidateCb: (candidate: string, mid: string) => void = () => {};
  private descriptionSent = false;
  private readonly queuedCandidates: Array<{ candidate: string; mid: string }> = [];
  private closed = false;

  constructor(_name: string, config: PeerTransportConfig, tlsOptions: ConnectionOptions = {}) {
    this.pc = new RTCPeerConnection({
      iceServers: weriftIceServers(config.iceServers),
      iceTransportPolicy: config.iceTransportPolicy,
      turnTlsOptions: tlsOptions,
    });
    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      const item = { candidate: candidate.candidate, mid: candidate.sdpMid ?? "0" };
      // The remote only adopts an attempt from an offer, so candidates follow the description.
      if (this.descriptionSent) this.localCandidateCb(item.candidate, item.mid);
      else this.queuedCandidates.push(item);
    });
  }

  onStateChange(cb: (state: string) => void): void {
    this.pc.connectionStateChange.subscribe((state) => cb(state));
  }
  onIceStateChange(cb: (state: string) => void): void {
    this.pc.iceConnectionStateChange.subscribe((state) => cb(state));
  }
  onGatheringStateChange(cb: (state: string) => void): void {
    this.pc.iceGatheringStateChange.subscribe((state) => cb(state));
  }
  onSignalingStateChange(cb: (state: string) => void): void {
    this.pc.signalingStateChange.subscribe((state) => cb(state));
  }
  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.localDescriptionCb = cb;
  }
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.localCandidateCb = cb;
  }
  onDataChannel(cb: (channel: PeerChannel) => void): void {
    this.pc.onDataChannel.subscribe((dc) => cb(new WeriftChannel(dc)));
  }

  createDataChannel(label: string): PeerChannel {
    const channel = new WeriftChannel(this.pc.createDataChannel(label));
    void this.negotiate("offer");
    return channel;
  }

  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    void this.pc.setRemoteDescription({ sdp, type }).then(
      () => (type === "offer" ? this.negotiate("answer") : undefined),
      () => this.close(),
    );
  }

  addRemoteCandidate(candidate: string, mid: string): void {
    void this.pc.addIceCandidate({ candidate, sdpMid: mid }).catch(() => {});
  }

  getSelectedCandidatePair(): {
    local: { candidate: string };
    remote: { candidate: string };
  } | null {
    const pair = this.pc.iceTransports[0]?.connection.nominated;
    const local = pair?.protocol.localCandidate;
    if (!pair || !local) return null;
    return {
      local: { candidate: local.toSdp() },
      remote: { candidate: pair.remoteCandidate.toSdp() },
    };
  }

  /** Transport of the client-to-TURN connection behind the selected local candidate, if it is relayed. */
  selectedTurnTransport(): TurnClientTransport | undefined {
    const protocol = this.pc.iceTransports[0]?.connection.nominated?.protocol;
    if (protocol?.type !== "turn") return undefined;
    const transport = (protocol as { turn?: { transport?: { type?: string } } }).turn?.transport
      ?.type;
    return transport === "udp" || transport === "tcp" || transport === "tls"
      ? transport
      : undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.pc.close().catch(() => {});
  }

  private async negotiate(kind: "offer" | "answer"): Promise<void> {
    try {
      const description =
        kind === "offer" ? await this.pc.createOffer() : await this.pc.createAnswer();
      await this.pc.setLocalDescription(description);
      if (this.closed) return;
      this.descriptionSent = true;
      this.localDescriptionCb(this.pc.localDescription?.sdp ?? description.sdp, kind);
      for (const item of this.queuedCandidates.splice(0))
        this.localCandidateCb(item.candidate, item.mid);
    } catch {
      this.close();
    }
  }
}
