import { fork, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataChannelClientTransport } from "../../../packages/p2p-prototype/src/client-transport.js";
import { startFakeAuthServer } from "../../../packages/p2p-prototype/src/fake-auth-server.js";
import { startGateway } from "../../../packages/p2p-prototype/src/gateway.js";
import { openSession, startPairing } from "../../../packages/p2p-prototype/src/gateway-client.js";
import { P2P_AGENT_MODULE_ENV, P2P_GATEWAY_ENV, P2P_PAIR_CODE_ENV, P2PNode } from "./p2p-node.js";

/**
 * Opt-in proof (RAKAZO_P2P_LOCAL_PROOF=1): a loopback gateway, the desktop node and a client
 * from p2p-prototype send one request for the API health over the WebRTC data channel.
 * RAKAZO_P2P_PROOF_ELECTRON=1 also launches the real app under xvfb with the native stack.
 */
const proof = process.env.RAKAZO_P2P_LOCAL_PROOF === "1";
const electronProof = proof && process.env.RAKAZO_P2P_PROOF_ELECTRON === "1";
const text = new TextDecoder();
const report = (line: string) => process.stdout.write(`P2P-PROOF ${line}\n`);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => undefined);
});

async function startProofGateway() {
  const auth = await startFakeAuthServer();
  const gateway = await startGateway({ port: 0, userVerifier: auth.verifier });
  cleanups.push(async () => {
    await gateway.close();
    await auth.close();
  });
  const sessionToken = "token";
  return { gateway, sessionToken };
}

async function healthOverChannel(input: {
  gatewayUrl: string;
  sessionToken: string;
  nodeId: string;
}) {
  const peerId = randomUUID();
  const { assertion } = await openSession(
    input.gatewayUrl,
    input.sessionToken,
    input.nodeId,
    peerId,
  );
  const started = Date.now();
  const client = await DataChannelClientTransport.connect({
    signalUrl: `${input.gatewayUrl}/signal`,
    selfId: peerId,
    remoteId: input.nodeId,
    initiator: true,
    authorization: `Assertion ${assertion}`,
    assertion,
    connectTimeoutMs: 10_000,
  });
  const connectedMs = Date.now() - started;
  const sent = Date.now();
  const response = await client.call({
    procedure: "health",
    body: new Uint8Array(),
    headers: {},
    signal: AbortSignal.timeout(10_000),
  });
  const roundTripMs = Date.now() - sent;
  const pair = client.selectedPair();
  client.close();
  return { response, connectedMs, roundTripMs, pair };
}

describe.runIf(proof)("p2p local proof", () => {
  it("answers an API health request over the data channel (stub API, agent in a child process)", async () => {
    const bundle = process.env[P2P_AGENT_MODULE_ENV];
    expect(bundle, `${P2P_AGENT_MODULE_ENV} is the built agent bundle`).toBeTruthy();
    const { gateway, sessionToken } = await startProofGateway();
    const api = createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
      res.end(req.url === "/health" ? JSON.stringify({ status: "ok" }) : "{}");
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => api.close(() => resolve())));
    const webUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const { code } = await startPairing(gateway.url, sessionToken);
    const userDataDir = await mkdtemp(path.join(tmpdir(), "p2p-proof-"));
    cleanups.push(() => rm(userDataDir, { recursive: true, force: true }));
    const node = new P2PNode({
      platform: process.platform,
      packaged: false,
      resourcesPath: "/unused",
      appPath: "/unused",
      userDataDir,
      env: {
        [P2P_GATEWAY_ENV]: gateway.url,
        [P2P_PAIR_CODE_ENV]: code,
        [P2P_AGENT_MODULE_ENV]: bundle!,
        PATH: process.env.PATH ?? "",
      },
      // Plain Node stands in for the utility process; the protocol is the same.
      spawnAgent: async (entry, env) => {
        const child = fork(entry, [], { env, stdio: "ignore" });
        return {
          postMessage: (message) => void child.send(message as never),
          on: ((event: "message" | "exit", listener: never) => child.on(event, listener)) as never,
          kill: () => child.kill(),
        };
      },
    });
    cleanups.push(() => node.stop());
    const status = await node.start(webUrl);
    expect(status.state).toBe("running");
    if (status.state !== "running") return;
    const until = Date.now() + 10_000;
    while (!gateway.connectedNodes().includes(status.nodeId) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.connectedNodes()).toContain(status.nodeId);

    const { response, connectedMs, roundTripMs, pair } = await healthOverChannel({
      gatewayUrl: gateway.url,
      sessionToken,
      nodeId: status.nodeId,
    });
    report(
      `stub-api status=${response.status} body=${text.decode(response.body)} connect_ms=${connectedMs} request_ms=${roundTripMs} pair=${JSON.stringify(pair)}`,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(text.decode(response.body))).toEqual({ status: "ok" });
  }, 60_000);

  it.runIf(electronProof)(
    "answers over the data channel from the real app with the native stack",
    async () => {
      const bundle = process.env[P2P_AGENT_MODULE_ENV];
      const pgBin = process.env.RAKAZO_PG_BIN_DIR;
      expect(bundle, `${P2P_AGENT_MODULE_ENV} is the built agent bundle`).toBeTruthy();
      expect(pgBin, "RAKAZO_PG_BIN_DIR is the bundled Postgres bin dir").toBeTruthy();
      const { gateway, sessionToken } = await startProofGateway();
      const { code } = await startPairing(gateway.url, sessionToken);
      const userDataDir = await mkdtemp(path.join(tmpdir(), "vnbot-p2p-"));
      await writeFile(path.join(userDataDir, ".keep"), "");
      cleanups.push(() => rm(userDataDir, { recursive: true, force: true }));
      const logFd = openSync(
        process.env.RAKAZO_P2P_PROOF_LOG ?? path.join(userDataDir, ".log"),
        "w",
      );
      const desktopDir = path.resolve(import.meta.dirname, "..");
      const electron = spawn(
        "xvfb-run",
        [
          "-a",
          "-s",
          "-screen 0 1280x800x24",
          path.join(desktopDir, "node_modules/.bin/electron"),
          ".",
          `--user-data-dir=${userDataDir}`,
          "--no-sandbox",
        ],
        {
          cwd: desktopDir,
          env: {
            ...process.env,
            [P2P_GATEWAY_ENV]: gateway.url,
            [P2P_PAIR_CODE_ENV]: code,
          },
          detached: true,
          stdio: ["ignore", logFd, logFd],
        },
      );
      const exited = once(electron, "exit");
      const postgresCount = () =>
        spawnSync("pgrep", ["-f", `postgres -D ${userDataDir}/pg/data`])
          .stdout.toString()
          .split("\n")
          .filter(Boolean).length;
      cleanups.push(async () => {
        // Like `pkill electron`: every process of the app gets SIGTERM at once.
        if (electron.pid && electron.exitCode === null) process.kill(-electron.pid, "SIGTERM");
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
        const until = Date.now() + 10_000;
        while (postgresCount() > 0 && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 100));
        report(`electron-shutdown postgres_remaining=${postgresCount()}`);
        expect(postgresCount()).toBe(0);
      });
      const until = Date.now() + 90_000;
      while (gateway.connectedNodes().length === 0 && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 250));
      const [nodeId] = gateway.connectedNodes();
      expect(nodeId, "the desktop node dialed the gateway").toBeTruthy();
      const { response, connectedMs, roundTripMs, pair } = await healthOverChannel({
        gatewayUrl: gateway.url,
        sessionToken,
        nodeId: nodeId!,
      });
      report(
        `electron status=${response.status} body=${text.decode(response.body)} connect_ms=${connectedMs} request_ms=${roundTripMs} pair=${JSON.stringify(pair)}`,
      );
      expect(response.status).toBe(200);
    },
    180_000,
  );
});
