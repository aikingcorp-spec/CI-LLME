import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { LOCAL_NODE_SESSION_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { DataChannelClientTransport } from "../../../packages/p2p-prototype/src/client-transport.js";
import { startFakeAuthServer } from "../../../packages/p2p-prototype/src/fake-auth-server.js";
import { startGateway } from "../../../packages/p2p-prototype/src/gateway.js";
import {
  completePairing,
  openSession,
  startPairing,
  unpairNode,
} from "../../../packages/p2p-prototype/src/gateway-client.js";
import { writeKeyFile } from "../../../packages/p2p-prototype/src/key-file.js";
import { generateKeyPair } from "../../../packages/p2p-prototype/src/pairing.js";
import { waitFor } from "../../../packages/p2p-prototype/src/test-util.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { browserP2PClient } from "../../../packages/testkit/src/p2p-browser-client.js";
import { P2P_GATEWAY_ENV, P2PNode } from "../../desktop/src/p2p-node.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const token = "ab".repeat(32);
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "real WebRTC carries authenticated node RPC, persists chat and rejects a foreign account",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-local-session-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      desktopStackToken: token,
      passwordAuth: false,
      emailAllowlist: true,
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
    });
    const email = `local-node-${Date.now()}@example.test`;
    const mint = (headers: Record<string, string>, address = email) =>
      handles.app.request(LOCAL_NODE_SESSION_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: address }),
      });
    try {
      expect((await mint({})).status).toBe(401);
      // The server-only endpoint is not reachable through the public auth route.
      expect(
        (
          await handles.app.request("/api/auth/local-node-session", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ email }),
          })
        ).status,
      ).toBe(404);
      const signUp = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password: "test-password-123", name: "No" }),
      });
      expect(signUp.status).toBeGreaterThanOrEqual(400);
      const capabilities = await handles.app.request("/api/auth/capabilities");
      expect(await capabilities.json()).toMatchObject({ passwordAuth: false, emailCode: false });

      const minted = await mint({ [LOCAL_SETTINGS_TOKEN_HEADER]: token });
      expect(minted.status).toBe(200);
      const cookie = sessionCookieHeader(minted);
      expect(cookie).not.toBe("");
      const session = await handles.app.request("/api/auth/get-session", {
        headers: { cookie },
      });
      expect((await session.json()).user).toMatchObject({ email, emailVerified: true });
      const me = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json: {} }),
      });
      expect(me.status).toBe(200);
      const api = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: 0 });
      await once(api, "listening");
      const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
      const auth = await startFakeAuthServer();
      const gateway = await startGateway({ port: 0, userVerifier: auth.verifier });
      const keyPair = generateKeyPair();
      const nodeId = `test-${randomUUID()}`;
      const { code } = await startPairing(gateway.url, "token");
      const paired = await completePairing(gateway.url, code, nodeId, keyPair);
      const relay = process.env.P2P_TEST_TURN === "1";
      const turn = {
        hostname: process.env.P2P_TEST_TURN_HOST || "127.0.0.1",
        port: 3479,
        username: "test",
        password: "test",
        relayType: "TurnUdp" as const,
      };
      const desktopData = join(dataDir, "desktop");
      await mkdir(join(desktopData, "p2p"), { recursive: true });
      const local = await handles.app
        .request("/api/auth/get-session", { headers: { cookie } })
        .then((response) => response.json());
      writeKeyFile(join(desktopData, "p2p", "node-key.json"), {
        ...keyPair,
        gatewayPublicKey: paired.gatewayPublicKey,
        user: paired.user,
        localUser: local.user.id,
      });
      await writeFile(join(desktopData, "p2p", "node-id"), nodeId);
      const node = new P2PNode({
        platform: process.platform,
        packaged: false,
        resourcesPath: "",
        appPath: fileURLToPath(new URL("../../desktop/", import.meta.url)),
        userDataDir: desktopData,
        env: { ...process.env, [P2P_GATEWAY_ENV]: gateway.url },
        stunServers: [],
        localSession: async () => ({ cookie }),
        spawnAgent: async (entry, env) => {
          const child = fork(entry, [], {
            env,
            stdio: process.env.P2P_DEBUG === "1" ? "inherit" : "ignore",
          });
          return {
            postMessage: (message) => {
              child.send(message as never);
            },
            on: ((event: string, listener: (...args: unknown[]) => void) =>
              child.on(event, listener)) as never,
            kill: () => child.kill(),
          };
        },
      });
      let transport:
        | DataChannelClientTransport
        | Awaited<ReturnType<typeof browserP2PClient>>
        | undefined;
      try {
        expect((await node.start(apiUrl)).state).toBe("running");
        await expect(
          openSession(gateway.url, "other-token", nodeId, randomUUID()),
        ).rejects.toThrow();
        const peerId = randomUUID();
        const session = await openSession(gateway.url, "token", nodeId, peerId);
        transport =
          process.env.P2P_TEST_BROWSER === "1"
            ? await browserP2PClient({
                apiUrl,
                gatewayUrl: gateway.url,
                nodeId,
                peerId,
                assertion: session.assertion,
                relay,
                turnHost: process.env.P2P_TEST_TURN_HOST,
                turnTransport: process.env.P2P_TEST_TURN_TRANSPORT === "tcp" ? "tcp" : "udp",
              })
            : await DataChannelClientTransport.connect({
                signalUrl: `${gateway.url}/signal`,
                selfId: peerId,
                remoteId: nodeId,
                initiator: true,
                authorization: `Assertion ${session.assertion}`,
                assertion: session.assertion,
                iceServers: relay ? [turn] : [],
                iceTransportPolicy: relay ? "relay" : "all",
                connectTimeoutMs: 10000,
              });
        const call = async (procedure: string, input: unknown = {}) => {
          const response = await transport!.call({
            procedure,
            headers: {
              "content-type": "application/json",
              cookie: "attacker=wrong",
              authorization: "Bearer wrong",
            },
            body: new TextEncoder().encode(JSON.stringify({ json: input })),
            signal: AbortSignal.timeout(10000),
          });
          expect(response.status, new TextDecoder().decode(response.body)).toBe(200);
          return JSON.parse(new TextDecoder().decode(response.body)).json;
        };
        expect(await call("me")).toMatchObject({ email });
        const bot = await call("bots/create", {
          name: "Remote helper",
          title: "Helper",
          description: "",
          instructions: "Help.",
        });
        expect(typeof bot.id).toBe("string");
        await call("threads/send", { botId: bot.id, text: "Message sent over WebRTC" });
        expect(JSON.stringify(await call("threads/get", { botId: bot.id }))).toContain(
          "Message sent over WebRTC",
        );
        expect(await transport.selectedPair()).toBeDefined();
        if (relay) expect(JSON.stringify(await transport.selectedPair())).toContain("typ relay");
        await unpairNode(gateway.url, "token", nodeId);
        await expect(openSession(gateway.url, "token", nodeId, randomUUID())).rejects.toThrow();
        await waitFor(() => !gateway.connectedNodes().includes(nodeId));
        await expect(
          transport.call({
            procedure: "me",
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode('{"json":{}}'),
            signal: AbortSignal.timeout(3000),
          }),
        ).rejects.toThrow();
      } finally {
        await transport?.close();
        await node.stop();
        await gateway.close();
        await auth.close();
        api.closeAllConnections();
        await new Promise<void>((resolve) => api.close(() => resolve()));
      }
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  60_000,
);
