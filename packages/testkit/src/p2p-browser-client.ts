/// <reference lib="dom" />
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { ClientCall } from "@rakazo/p2p-prototype/client-transport";
import { build } from "esbuild";

/** Actual Chromium RTC. Only account authentication is supplied by the integration fixture. */
export async function browserP2PClient(input: {
  apiUrl: string;
  gatewayUrl: string;
  nodeId: string;
  peerId: string;
  assertion: string;
  relay: boolean;
  turnHost?: string;
}) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../../p2p-prototype/src/browser.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "P2PLibrary",
  });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const page = await browser.newPage();
  try {
    if (process.env.P2P_DEBUG === "1")
      page.on("console", (message) => process.stderr.write(`browser: ${message.text()}\n`));
    await page.goto(`${input.apiUrl}/health`);
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.evaluate(`window.P2PConnect = async (options) => {
      const NativeWS = window.WebSocket;
      window.WebSocket = class extends NativeWS { constructor(...args) { super(...args); this.addEventListener('message', event => { const frame = JSON.parse(event.data); console.log('signal', frame.kind, frame.payload?.type); }); } };
      const NativeRTC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativeRTC { constructor(config) { super(config); window.testRTC = this; this.addEventListener("icecandidateerror", event => console.log("ICE error", event.errorCode, event.errorText)); this.addEventListener("icecandidate", event => console.log("local candidate", event.candidate?.type)); } };
      const peer = await P2PLibrary.connectBrowserPeer({ signalUrl: options.gatewayUrl + '/signal', selfId: options.peerId,
        remoteId: options.nodeId, assertion: options.assertion, initiator: true,
        iceTransportPolicy: options.relay ? 'relay' : 'all',
        iceServers: options.relay ? [{ urls: 'turn:' + (options.turnHost || '127.0.0.1') + ':3479?transport=tcp', username: 'test', credential: 'test' }] : [],
        connectTimeoutMs: 10000 });
      window.testClient = new P2PLibrary.DataChannelClientTransport(peer, options.assertion);
      try { await window.testClient.ready; } catch (error) { console.log("RTC state", window.testRTC.connectionState, window.testRTC.iceConnectionState, window.testRTC.remoteDescription?.type, error.cause?.message); throw error; }
    }`);
    await page.evaluate((options) => Reflect.get(window, "P2PConnect")(options), input);
    return {
      async call(call: ClientCall) {
        const result = await page.evaluate(
          async (payload) => {
            const reply = await Reflect.get(window, "testClient").call({
              ...payload,
              body: new Uint8Array(payload.body),
              signal: AbortSignal.timeout(10000),
            });
            return { ...reply, body: Array.from(reply.body) as number[] };
          },
          { procedure: call.procedure, headers: call.headers, body: Array.from(call.body) },
        );
        return { ...result, body: new Uint8Array(result.body) };
      },
      async selectedPair() {
        return page.evaluate(async () => {
          const stats = await Reflect.get(window, "testRTC").getStats();
          for (const entry of stats.values()) {
            if (entry.type !== "transport" || !entry.selectedCandidatePairId) continue;
            const pair = stats.get(entry.selectedCandidatePairId);
            return {
              local: "typ " + stats.get(pair.localCandidateId).candidateType,
              remote: "typ " + stats.get(pair.remoteCandidateId).candidateType,
            };
          }
          return null;
        });
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
