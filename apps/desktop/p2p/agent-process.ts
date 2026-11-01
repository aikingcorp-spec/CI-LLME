import { cleanup } from "node-datachannel";
import { fetchNodeTurnServers } from "../../../packages/p2p-prototype/src/gateway-client.js";
import { startNodeAgent } from "../../../packages/p2p-prototype/src/node-agent.js";
import { forwardChannelHandler } from "../../../packages/p2p-prototype/src/node-channel-server.js";
import { desktopChannelHandler } from "../src/p2p-channel-handler.js";
import { desktopIceServers } from "../src/p2p-node.js";

/**
 * Runs the node agent in an Electron utility process. libdatachannel misparses SDP once koffi
 * is loaded in the same process (as it is in the app's main process) and needs `cleanup()`
 * before exit, so it stays out of main. Plain Node `fork` is also accepted for the local proof.
 */
interface Start {
  type: "start";
  gatewayUrl: string;
  nodeId: string;
  webUrl: string;
  localHeaders?: Record<string, string>;
  key: { publicKey: string; privateKey: string; gatewayPublicKey: string; user: string };
}

const parentPort = process.parentPort as
  | {
      on(event: "message", cb: (e: { data: unknown }) => void): void;
      postMessage(m: unknown): void;
    }
  | undefined;
const post = (message: unknown) =>
  parentPort ? parentPort.postMessage(message) : process.send?.(message as never);
const listen = (cb: (message: unknown) => void) =>
  parentPort ? parentPort.on("message", (e) => cb(e.data)) : process.on("message", cb);

let agent: ReturnType<typeof startNodeAgent> | undefined;
listen(async (message) => {
  const m = message as Start | { type: "stop" };
  if (m.type === "start") {
    try {
      agent = startNodeAgent({
        gatewayUrl: m.gatewayUrl,
        nodeId: m.nodeId,
        keyPair: m.key,
        iceServers: () => desktopIceServers(m.gatewayUrl, m.nodeId, m.key, fetchNodeTurnServers),
        // The gateway's plaintext HTTP relay is off; only the data channel carries requests.
        handler: async () => ({ status: 404, headers: {}, body: new Uint8Array() }),
        channel: {
          gatewayPublicKey: m.key.gatewayPublicKey,
          allowedUsers: [m.key.user],
          handler: desktopChannelHandler(m.webUrl, forwardChannelHandler(m.webUrl, m.localHeaders)),
        },
      });
      const current = agent;
      const deadline = Date.now() + 15_000;
      while (agent === current && !current.connected() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      if (agent !== current || !current.connected()) throw new Error("Gateway unavailable");
      post({ type: "started" });
    } catch {
      post({ type: "error" });
      process.exit(1);
    }
  } else if (m.type === "stop") {
    await agent?.close().catch(() => undefined);
    cleanup();
    process.exit(0);
  }
});
