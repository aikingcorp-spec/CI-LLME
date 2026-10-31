import { P2PConnectError } from "./connect-error.js";
import { DataChannelClientTransport as SharedClient } from "./data-channel-client.js";
import type { PeerOptions } from "./webrtc-peer.js";
import { connectPeer } from "./webrtc-peer.js";

export type { ClientCall, ClientResponse, ClientTransport } from "./data-channel-client.js";
export class DataChannelClientTransport extends SharedClient {
  static async connect(
    options: PeerOptions & { assertion: string },
  ): Promise<DataChannelClientTransport> {
    const peer = await connectPeer(options);
    const client = new DataChannelClientTransport(peer, options.assertion);
    try {
      await client.ready;
      return client;
    } catch (error) {
      client.close();
      throw error instanceof Error && error.cause instanceof P2PConnectError ? error.cause : error;
    }
  }
}
