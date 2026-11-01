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
  turnTransport?: string | null;
}
interface ForwarderStats {
  opened: number;
  open: number;
  bytes_up: number;
  bytes_down: number;
  dgrams_up: number;
  dgrams_down: number;
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
const FORWARDER_SCRIPT = fileURLToPath(new URL("../scripts/turn-forwarder.py", import.meta.url));
const STUN_SCRIPT = fileURLToPath(new URL("../scripts/stun-server.py", import.meta.url));
const NAT_PROBE_SCRIPT = fileURLToPath(new URL("../scripts/nat-probe.py", import.meta.url));
const PEER_SCRIPT = fileURLToPath(new URL("./bin/two-machine-peer.ts", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const STUN_PORTS = [3478, 3480];
const ROUTED = process.env.P2P_TOPOLOGY === "routed";
// The topologies use disjoint namespace names and subnets (see the script), so one can run while
// another worktree uses the other. NAT: peers on 10.78.0.x behind their own routers. Routed (no
// NAT): A on 10.77.10.x and B on 10.77.20.x with one router between them.
const NAMESPACE: Record<Machine, string> = ROUTED
  ? { A: "p2pA", B: "p2pB" }
  : { A: "pnA", B: "pnB" };
const GATEWAY_HOST: Record<Machine, string> = ROUTED
  ? { A: "10.77.1.1", B: "10.77.2.1" }
  : { A: "10.78.1.1", B: "10.78.2.1" };
const PUBLIC_NAMESPACE = "pnPub";
const STUN_HOST = "10.78.3.10";
const PEER_ADDRESS = ROUTED ? /10\.77\.(10|20)\./ : /10\.78\.0\./;
// Optional TURN relay without NAT: P2P_NODE_TURN=<path to node-turn package>. The relay runs in the
// root namespace and both peers are forced to iceTransportPolicy=relay.
const NODE_TURN = process.env.P2P_NODE_TURN;
const TURN_PORT = 3479;
const TURN_USER = "p2p-test";
const TURN_PASS = randomBytes(12).toString("hex");
const SESSION_TOKEN = "token";
// Real TURN (stage 3): P2P_TURN_CREDS_FILE=<coturn REST creds file>. Peers read the file themselves.
// P2P_TURN_FORWARD=1 points them at a root-namespace L4 forwarder (no NAT on the box).
const TURN_CREDS_FILE = process.env.P2P_TURN_CREDS_FILE;
const TURN_PUBLIC_IP = process.env.P2P_TURN_PUBLIC_IP;
// TURN over TCP/TLS (stage 4): P2P_PEER_IMPL=werift runs the peers on the test-only werift stack,
// P2P_EXPECT_TURN_TRANSPORT=tcp|tls asserts the client-to-TURN transport of the selected relay
// candidate and, through the forwarder's wire counters, that nothing went to the TURN port over UDP.
// P2P_TURN_TLS_CA_FILE pins the self-signed certificate of the TURNS server.
const PEER_IMPL = process.env.P2P_PEER_IMPL;
const EXPECT_TURN_TRANSPORT = process.env.P2P_EXPECT_TURN_TRANSPORT;
const TURN_PORT_FOR: Record<string, number> = { tcp: 3479, tls: 5350 };
// Comma list of acceptable candidate types for both ends of the selected pair, e.g. "srflx,relay".
const EXPECT_CANDIDATE_TYPES = process.env.P2P_EXPECT_CANDIDATE_TYPE?.split(",").filter(Boolean);
// Real kernel NAT (topology nat): cone keeps the source port, symmetric picks a port per 5-tuple.
const NAT_TYPE = process.env.P2P_NAT_TYPE === "symmetric" ? "symmetric" : "cone";
const NAT = NETNS_MODE && !ROUTED;
const STUN_URL =
  process.env.P2P_STUN_URL ?? (NAT ? `stun:${STUN_HOST}:${STUN_PORTS[0]}` : undefined);
const candidateType = (candidate: string): string | undefined => /\btyp (\w+)/.exec(candidate)?.[1];

// Runs a command inside a namespace as the invoking user, so killing it needs no root.
function inNamespace(namespace: string, command: string[]): string[] {
  return [
    "-n",
    "ip",
    "netns",
    "exec",
    namespace,
    "sudo",
    "-n",
    "-u",
    userInfo().username,
    ...command,
  ];
}

function netnsAvailable(): boolean {
  try {
    execFileSync("sudo", ["-n", "ip", "netns", "list"], { stdio: "ignore" });
    if (!ROUTED) execFileSync(TOPOLOGY_SCRIPT, ["check"], { stdio: "ignore" });
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
    let forwarderStats: (() => Promise<Record<string, ForwarderStats>>) | undefined;
    let stun: { stop(): void } | undefined;
    let gatewayPort: string;
    let workDir: string;
    let authServer: Awaited<ReturnType<typeof startFakeAuthServer>>;
    const procs = new Map<string, PeerProc>();
    const logDir = process.env.P2P_LOG_DIR;

    beforeAll(async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      if (NETNS_MODE) execFileSync(TOPOLOGY_SCRIPT, ["setup"]);
      if (NAT) {
        const server = spawn(
          "sudo",
          inNamespace(PUBLIC_NAMESPACE, ["python3", STUN_SCRIPT, STUN_HOST, STUN_PORTS.join(",")]),
        );
        const pid = await new Promise<number>((resolve, reject) => {
          server.stdout.once("data", (chunk: Buffer) =>
            resolve(Number(/stun ready (\d+)/.exec(String(chunk))?.[1])),
          );
          server.once("exit", (code) => reject(new Error(`stun server exited ${code}`)));
        });
        stun = {
          stop: () => {
            try {
              process.kill(pid, "SIGTERM");
            } catch {}
          },
        };
      }
      if (TURN_CREDS_FILE && process.env.P2P_TURN_FORWARD === "1") {
        const fwd = spawn("python3", [
          FORWARDER_SCRIPT,
          TURN_PUBLIC_IP ?? "",
          Object.values(GATEWAY_HOST).join(","),
          process.env.P2P_TURN_PORTS ?? "3479,5350",
        ]);
        const statsWaiters: Array<(stats: Record<string, ForwarderStats>) => void> = [];
        await new Promise<void>((resolve, reject) => {
          createInterface({ input: fwd.stdout }).on("line", (line) => {
            if (line.startsWith("stats ")) {
              if (logDir) appendFileSync(join(logDir, "forwarder.log"), `${line}\n`);
              const stats = JSON.parse(line.slice("stats ".length)) as Record<
                string,
                ForwarderStats
              >;
              for (const waiter of statsWaiters.splice(0)) waiter(stats);
            } else resolve();
          });
          fwd.once("exit", (code) => reject(new Error(`forwarder exited ${code}`)));
        });
        forwarderStats = () =>
          new Promise((resolve) => {
            statsWaiters.push(resolve);
            fwd.kill("SIGUSR1");
          });
        turn = { stop: () => fwd.kill() };
      }
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

    it.skipIf(!NAT)("maps both peers through the configured kernel NAT", () => {
      for (const machine of ["A", "B"] as const) {
        const out = execFileSync(
          "sudo",
          inNamespace(NAMESPACE[machine], [
            "python3",
            NAT_PROBE_SCRIPT,
            STUN_HOST,
            ...STUN_PORTS.map(String),
          ]),
          { encoding: "utf8" },
        );
        if (logDir) appendFileSync(join(logDir, `nat-probe-${machine}.json`), out);
        const probe = JSON.parse(out) as { mapped: Record<string, string>; mapping: string };
        expect(probe.mapping).toBe(
          NAT_TYPE === "cone" ? "endpoint-independent" : "endpoint-dependent",
        );
        const publicIp = machine === "A" ? "10.78.3.11" : "10.78.3.12";
        for (const mapped of Object.values(probe.mapped))
          expect(mapped).toMatch(new RegExp(`^${publicIp}:`));
      }
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
      stun?.stop();
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
      if (STUN_URL) vars.STUN_URL = STUN_URL;
      if (TURN_CREDS_FILE) {
        vars.TURN_CREDS_FILE = TURN_CREDS_FILE;
        if (process.env.P2P_TURN_FORWARD === "1") vars.TURN_HOST_OVERRIDE = GATEWAY_HOST[machine];
        if (process.env.P2P_TURN_TRANSPORTS) vars.TURN_TRANSPORTS = process.env.P2P_TURN_TRANSPORTS;
        if (process.env.P2P_ICE_POLICY) vars.ICE_TRANSPORT_POLICY = process.env.P2P_ICE_POLICY;
        if (PEER_IMPL) vars.PEER_IMPL = PEER_IMPL;
        if (process.env.P2P_TURN_TLS_CA_FILE)
          vars.TURN_TLS_CA_FILE = process.env.P2P_TURN_TLS_CA_FILE;
      }
      const nodeArgs = ["--import", TSX_LOADER, PEER_SCRIPT, role];
      const child = NETNS_MODE
        ? spawn(
            "sudo",
            inNamespace(NAMESPACE[machine], [
              "env",
              ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
              process.execPath,
              ...nodeArgs,
            ]),
            { stdio: ["ignore", "pipe", "pipe"] },
          )
        : spawn(process.execPath, nodeArgs, {
            env: { ...process.env, ...vars },
            stdio:
              process.platform === "win32"
                ? ["ignore", "pipe", "pipe", "ipc"]
                : ["ignore", "pipe", "pipe"],
          });
      if (!child.stdout || !child.stderr)
        throw new Error("P2P harness requires piped stdout and stderr");
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
            // Windows SIGTERM is forceful termination; desktop uses cooperative IPC shutdown.
            if (process.platform === "win32" && signal === "SIGTERM" && child.connected) {
              child.send({ type: "stop" });
              return;
            }
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
      const sides = [pair.local, pair.remote];
      if (NAT) {
        const types = sides.map(candidateType);
        expect(types.every((type) => type === "host")).toBe(false);
      }
      const expectedTypes =
        EXPECT_CANDIDATE_TYPES ??
        (NODE_TURN ? ["relay"] : NAT ? ["srflx", "prflx", "relay"] : undefined);
      if (expectedTypes) {
        for (const side of sides) {
          expect(expectedTypes).toContain(candidateType(side));
          if (candidateType(side) === "relay" && TURN_PUBLIC_IP) {
            expect(side).toContain(` ${TURN_PUBLIC_IP} `);
          }
        }
      } else {
        expect(pair.local).toMatch(PEER_ADDRESS);
        expect(pair.remote).toMatch(PEER_ADDRESS);
      }
      if (EXPECT_TURN_TRANSPORT) {
        expect(proc.last("selected_pair").turnTransport).toBe(EXPECT_TURN_TRANSPORT);
        expect(proc.last("channel_open").turnTransport).toBe(EXPECT_TURN_TRANSPORT);
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

    it.runIf(EXPECT_TURN_TRANSPORT && TURN_CREDS_FILE)(
      "reached the TURN server only over the expected stream transport, and released it",
      async () => {
        const expected = EXPECT_TURN_TRANSPORT ?? "";
        const port = TURN_PORT_FOR[expected];
        if (!port || !forwarderStats) throw new Error(`no forwarder stats for ${expected}`);
        const stats = await forwarderStats();
        for (const [key, value] of Object.entries(stats)) {
          if (key === `tcp:${port}`) {
            expect(value.opened).toBeGreaterThanOrEqual(2);
            expect(value.bytes_up).toBeGreaterThan(0);
            expect(value.bytes_down).toBeGreaterThan(0);
          } else {
            // The other TURN port and any UDP datagram toward either port stay untouched.
            expect(value.opened + value.dgrams_up + value.dgrams_down, key).toBe(0);
          }
        }
        expect(stats[`tcp:${port}`]).toBeDefined();
        // Every killed or closed peer must have dropped its TURN connection, which frees its allocation.
        let open = stats[`tcp:${port}`]?.open ?? -1;
        for (let i = 0; i < 100 && open !== 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          open = (await forwarderStats())[`tcp:${port}`]?.open ?? -1;
        }
        expect(open).toBe(0);
      },
      30_000,
    );
  },
);
