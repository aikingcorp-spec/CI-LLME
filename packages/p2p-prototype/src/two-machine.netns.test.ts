import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeAuthServer } from "./fake-auth-server.js";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { completePairing, startPairing } from "./gateway-client.js";
import { writeKeyFile } from "./key-file.js";
import { generateKeyPair } from "./pairing.js";
import { waitFor } from "./test-util.js";

type Machine = "A" | "B";
interface PeerEvent {
  event: string;
  pid: number;
  session?: number;
  reason?: string;
  from?: { role: string; pid: number };
  pair?: { local: string; remote: string } | null;
  localCandidates?: string[];
}
interface PeerProc {
  events: PeerEvent[];
  stderr: string[];
  exitCode(): number | null | undefined;
  pid(): number;
  signal(signal: NodeJS.Signals): void;
  count(event: string): number;
  last(event: string): PeerEvent;
}

const NETNS_MODE = process.env.P2P_NETNS === "1";
const TOPOLOGY_SCRIPT = fileURLToPath(new URL("../scripts/netns-two-machines.sh", import.meta.url));
const PEER_SCRIPT = fileURLToPath(new URL("./bin/two-machine-peer.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const NAMESPACE: Record<Machine, string> = { A: "p2pA", B: "p2pB" };
const GATEWAY_HOST: Record<Machine, string> = { A: "10.77.1.1", B: "10.77.2.1" };
const ROUTED = process.env.P2P_TOPOLOGY === "routed";
// NAT topology puts both peers on 10.77.0.x behind their own routers; the routed (no-NAT) topology
// puts A on 10.77.10.x and B on 10.77.20.x with one router between them.
const PEER_ADDRESS = ROUTED ? /10\.77\.(10|20)\./ : /10\.77\.0\./;
// Optional TURN relay without NAT: P2P_NODE_TURN=<path to node-turn package>. The relay runs in the
// root namespace and both peers are forced to iceTransportPolicy=relay.
const NODE_TURN = process.env.P2P_NODE_TURN;
const TURN_PORT = 3479;
const TURN_USER = "p2p-test";
const TURN_PASS = randomBytes(12).toString("hex");
const SESSION_TOKEN = "token";
const EXPECT_CANDIDATE_TYPE = process.env.P2P_EXPECT_CANDIDATE_TYPE;

function netnsAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "ip", "netns", "list"], { stdio: "ignore" });
    if (!ROUTED) execFileSync("sudo", ["-n", "iptables", "-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(NETNS_MODE && !netnsAvailable())(
  `two machines over a data channel (${NETNS_MODE ? "network namespaces" : "loopback"})`,
  () => {
    let gateway: Gateway;
    let turn: { stop(): void } | undefined;
    let gatewayPort: string;
    let workDir: string;
    let authServer: Awaited<ReturnType<typeof startFakeAuthServer>>;
    const procs = new Map<string, PeerProc>();
    const logDir = process.env.P2P_LOG_DIR;

    beforeAll(async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      if (NETNS_MODE) execFileSync(TOPOLOGY_SCRIPT, ["setup"]);
      if (NODE_TURN) {
        const Turn = createRequire(import.meta.url)(NODE_TURN) as new (
          o: Record<string, unknown>,
        ) => { start(): void; stop(): void };
        const server = new Turn({
          listeningPort: TURN_PORT,
          listeningIps: NETNS_MODE ? Object.values(GATEWAY_HOST) : ["127.0.0.1"],
          authMech: "long-term",
          credentials: { [TURN_USER]: TURN_PASS },
          realm: "p2p-test",
          debugLevel: "OFF",
        });
        server.start();
        turn = server;
      }
      authServer = await startFakeAuthServer();
      gateway = await startGateway({
        port: 0,
        host: NETNS_MODE ? "0.0.0.0" : "127.0.0.1",
        userVerifier: authServer.verifier,
      });
      gatewayPort = new URL(gateway.url).port;
      workDir = mkdtempSync(join(tmpdir(), "p2p-two-machine-"));
      if (logDir) mkdirSync(logDir, { recursive: true });
    });

    afterEach(async () => {
      for (const proc of procs.values()) {
        if (proc.exitCode() === undefined) proc.signal("SIGKILL");
      }
      await waitFor(() => [...procs.values()].every((p) => p.exitCode() !== undefined), 10_000);
      procs.clear();
    });

    afterAll(async () => {
      turn?.stop();
      await gateway.close();
      await authServer.close();
      rmSync(workDir, { recursive: true, force: true });
      if (NETNS_MODE) execFileSync(TOPOLOGY_SCRIPT, ["teardown"]);
      vi.restoreAllMocks();
    });

    const gatewayUrl = (machine: Machine): string =>
      NETNS_MODE
        ? `http://${GATEWAY_HOST[machine]}:${gatewayPort}`
        : `http://127.0.0.1:${gatewayPort}`;

    function launch(
      label: string,
      role: "node" | "client",
      machine: Machine,
      env: Record<string, string>,
    ): PeerProc {
      const vars: Record<string, string> = {
        ...env,
        MACHINE: machine,
        GATEWAY_URL: gatewayUrl(machine),
        HEARTBEAT_MS: "250",
        DEAD_AFTER_MS: "2000",
        RETRY_MS: "250",
        HOME: process.env.HOME ?? tmpdir(),
        ...(process.env.P2P_DEBUG ? { P2P_DEBUG: process.env.P2P_DEBUG } : {}),
      };
      if (NODE_TURN) {
        const host = NETNS_MODE ? GATEWAY_HOST[machine] : "127.0.0.1";
        vars.ICE_SERVERS = `turn:${TURN_USER}:${TURN_PASS}@${host}:${TURN_PORT}?transport=udp`;
        vars.ICE_TRANSPORT_POLICY = "relay";
      }
      const nodeArgs = ["--import", TSX_LOADER, PEER_SCRIPT, role];
      const child = NETNS_MODE
        ? spawn(
            "sudo",
            [
              "-n",
              "ip",
              "netns",
              "exec",
              NAMESPACE[machine],
              "sudo",
              "-n",
              "-u",
              userInfo().username,
              "env",
              ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
              process.execPath,
              ...nodeArgs,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          )
        : spawn(process.execPath, nodeArgs, {
            env: { ...process.env, ...vars },
            stdio: ["ignore", "pipe", "pipe"],
          });
      const events: PeerEvent[] = [];
      const stderr: string[] = [];
      let exitCode: number | null | undefined;
      const record = (line: string): void => {
        if (logDir) appendFileSync(join(logDir, `${label}.log`), `${line}\n`);
      };
      createInterface({ input: child.stdout }).on("line", (line) => {
        record(line);
        try {
          events.push(JSON.parse(line) as PeerEvent);
        } catch {
          stderr.push(line);
        }
      });
      createInterface({ input: child.stderr }).on("line", (line) => {
        record(`stderr: ${line}`);
        stderr.push(line);
      });
      child.on("exit", (code) => {
        exitCode = code;
        record(`exit: ${code}`);
      });
      const proc: PeerProc = {
        events,
        stderr,
        exitCode: () => exitCode,
        pid: () => events.find((e) => e.event === "started")?.pid ?? child.pid ?? 0,
        signal: (signal) => {
          try {
            process.kill(proc.pid(), signal);
          } catch {}
        },
        count: (event) => events.filter((e) => e.event === event).length,
        last: (event) => {
          const found = events.findLast((e) => e.event === event);
          if (!found) throw new Error(`no ${event} event`);
          return found;
        },
      };
      procs.set(label, proc);
      return proc;
    }

    async function until(what: string, condition: () => boolean, timeoutMs = 25_000) {
      try {
        await waitFor(condition, timeoutMs);
      } catch {
        const dump = [...procs.entries()].map(
          ([label, p]) =>
            `--- ${label} (exit ${p.exitCode()})\n${p.events
              .slice(-12)
              .map((e) => JSON.stringify(e))
              .join("\n")}\n${p.stderr.slice(-12).join("\n")}`,
        );
        throw new Error(`timed out waiting for ${what}\n${dump.join("\n")}`);
      }
    }

    async function pairNode(): Promise<{ nodeId: string; keyFile: string; clientId: string }> {
      const nodeId = `node-${randomBytes(3).toString("hex")}`;
      const clientId = `peer-${randomBytes(3).toString("hex")}`;
      const keyPair = generateKeyPair();
      const base = `http://127.0.0.1:${gatewayPort}`;
      const { code } = await startPairing(base, SESSION_TOKEN);
      const { gatewayPublicKey, user } = await completePairing(base, code, nodeId, keyPair);
      const keyFile = join(workDir, `${nodeId}.json`);
      writeKeyFile(keyFile, { ...keyPair, gatewayPublicKey, user });
      return { nodeId, keyFile, clientId };
    }

    const startNode = (label: string, ids: Awaited<ReturnType<typeof pairNode>>) =>
      launch(label, "node", "B", {
        NODE_ID: ids.nodeId,
        NODE_KEY_FILE: ids.keyFile,
        CLIENT_ID: ids.clientId,
      });
    const startClient = (label: string, ids: Awaited<ReturnType<typeof pairNode>>) =>
      launch(label, "client", "A", {
        NODE_ID: ids.nodeId,
        CLIENT_ID: ids.clientId,
        SESSION_TOKEN,
      });

    const exchanged = (proc: PeerProc, sessions: number): boolean =>
      proc.count("channel_open") >= sessions &&
      proc.count("request_sent") >= sessions &&
      proc.count("request_received") >= sessions &&
      proc.count("response_sent") >= sessions &&
      proc.count("response_received") >= sessions &&
      proc.count("selected_pair") >= sessions;

    function expectCloseHandshake(initiator: PeerProc, responder: PeerProc): void {
      const initiated = initiator.events.map((e) => e.event);
      const answered = responder.events.map((e) => e.event);
      expect(initiated).toContain("bye_sent");
      expect(initiated).toContain("bye_ack_received");
      expect(initiated.indexOf("bye_sent")).toBeLessThan(initiated.indexOf("bye_ack_received"));
      expect(answered).toContain("bye_received");
      expect(answered).toContain("bye_ack_sent");
      expect(answered.indexOf("bye_received")).toBeLessThan(answered.indexOf("bye_ack_sent"));
      expect(responder.last("session_end").reason).toBe("remote-bye");
    }

    function expectPeerPath(proc: PeerProc): void {
      const pair = proc.last("selected_pair").pair;
      expect(pair).toBeTruthy();
      if (!pair) return;
      if (!NETNS_MODE && !NODE_TURN) return;
      const expectedType = EXPECT_CANDIDATE_TYPE ?? (NODE_TURN ? "relay" : undefined);
      if (expectedType) {
        expect(pair.local).toContain(`typ ${expectedType}`);
        expect(pair.remote).toContain(`typ ${expectedType}`);
      } else {
        expect(pair.local).toMatch(PEER_ADDRESS);
        expect(pair.remote).toMatch(PEER_ADDRESS);
      }
    }

    it("exchanges requests both ways, reconnects after the node is killed, and closes with BYE/BYE_ACK", async () => {
      const ids = await pairNode();
      const node1 = startNode("restart-node-1", ids);
      const client = startClient("restart-client", ids);

      await until("first exchange", () => exchanged(client, 1) && exchanged(node1, 1));
      expect(client.last("response_received").from).toMatchObject({
        role: "node",
        pid: node1.pid(),
      });
      expect(node1.last("response_received").from).toMatchObject({
        role: "client",
        pid: client.pid(),
      });
      expect(node1.last("request_received").session).toBe(1);
      expectPeerPath(client);
      expectPeerPath(node1);

      node1.signal("SIGKILL");
      await until("killed node to exit", () => node1.exitCode() !== undefined);
      await until("client to notice the lost node", () => client.count("session_end") >= 1);
      expect(["heartbeat-timeout", "channel-closed"]).toContain(client.last("session_end").reason);
      const connecting = client.count("connecting");
      await until("client to dial again", () => client.count("connecting") > connecting);

      const node2 = startNode("restart-node-2", ids);
      await until("exchange on the new channel", () => exchanged(client, 2) && exchanged(node2, 1));
      expect(node2.pid()).not.toBe(node1.pid());
      expect(client.last("response_received").from).toMatchObject({
        role: "node",
        pid: node2.pid(),
      });
      expect(node2.last("response_received").from).toMatchObject({
        role: "client",
        pid: client.pid(),
      });
      expectPeerPath(client);
      expectPeerPath(node2);

      client.signal("SIGTERM");
      await until("client to exit", () => client.exitCode() !== undefined);
      expect(client.exitCode()).toBe(0);
      await until("node to see the close", () => node2.count("session_end") >= 1);
      expectCloseHandshake(client, node2);

      node2.signal("SIGTERM");
      await until("node to exit", () => node2.exitCode() !== undefined);
      expect(node2.exitCode()).toBe(0);
    }, 90_000);

    it("closes with BYE/BYE_ACK when the node ends the session", async () => {
      const ids = await pairNode();
      const node = startNode("close-node", ids);
      const client = startClient("close-client", ids);

      await until("exchange", () => exchanged(client, 1) && exchanged(node, 1));

      node.signal("SIGTERM");
      await until("node to exit", () => node.exitCode() !== undefined);
      expect(node.exitCode()).toBe(0);
      await until("client to see the close", () => client.count("session_end") >= 1);
      expectCloseHandshake(node, client);

      client.signal("SIGTERM");
      await until("client to exit", () => client.exitCode() !== undefined);
      expect(client.exitCode()).toBe(0);
    }, 60_000);
  },
);
