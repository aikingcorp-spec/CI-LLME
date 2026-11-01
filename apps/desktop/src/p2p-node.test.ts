import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNodeTurnServers } from "../../../packages/p2p-prototype/src/gateway-client.js";
import {
  generateKeyPair,
  nodeProofMessage,
  parseNodeProof,
  verify,
} from "../../../packages/p2p-prototype/src/pairing.js";
import type { P2PChild, P2PNodeKeyFile, P2PPairingModule } from "./p2p-node.js";
import {
  desktopIceServers,
  hasNativeAddon,
  nodeDatachannelBinaryDir,
  P2P_AGENT_MODULE_ENV,
  P2P_GATEWAY_ENV,
  P2P_PAIR_CODE_ENV,
  P2PNode,
  p2pBundlePaths,
  p2pUnavailableMessage,
  parseGatewayUrl,
} from "./p2p-node.js";

const WIN_RESOURCES = "C:\\Users\\Ada\\AppData\\Local\\Programs\\VNBot\\resources";

describe("desktop TURN discovery", () => {
  afterEach(() => vi.unstubAllGlobals());
  const key = generateKeyPair();
  const gatewayUrl = "https://gateway.example.test";
  const turn = {
    urls: [
      "turn:relay.example.test:3479?transport=udp",
      "turn:relay.example.test:3479?transport=tcp",
      "turns:relay.example.test:5350",
    ],
    username: "test-expiry:node-1",
    credential: "dummy-turn-credential",
    ttl: 600,
  };
  it("authenticates with the node key and merges UDP, TCP and TLS TURN with STUN", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json(turn));
    vi.stubGlobal("fetch", request);
    const servers = await desktopIceServers(gatewayUrl, "node-1", key, fetchNodeTurnServers);
    expect(servers).toEqual([
      "stun:stun.l.google.com:19302",
      ...["TurnUdp", "TurnTcp", "TurnTls"].map((relayType) => ({
        hostname: "relay.example.test",
        port: relayType === "TurnTls" ? 5350 : 3479,
        username: turn.username,
        password: turn.credential,
        relayType,
      })),
    ]);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(`${gatewayUrl}/turn-credentials?peer=node-1`);
    const header = new Headers(init?.headers).get("authorization")!;
    expect(header.startsWith("Node ")).toBe(true);
    const proof = parseNodeProof(header.slice(5))!;
    expect(
      verify(key.publicKey, nodeProofMessage("signal", proof.nodeId, proof.ts), proof.sig),
    ).toBe(true);
    expect(init).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    await desktopIceServers(gatewayUrl, "node-1", key, fetchNodeTurnServers);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(["501", "500", "network", "malformed"])(
    "keeps configured STUN on TURN %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "network") throw new Error("offline");
          return failure === "malformed"
            ? Response.json({ ...turn, urls: [] })
            : new Response(null, { status: Number(failure) });
        }),
      );
      await expect(
        desktopIceServers(gatewayUrl, "node-1", key, fetchNodeTurnServers, [
          "stun:stun.example.test:3478",
        ]),
      ).resolves.toEqual(["stun:stun.example.test:3478"]);
    },
  );
});

describe("nodeDatachannelBinaryDir", () => {
  it("points at the unpacked addon directory with Windows separators", () => {
    expect(
      nodeDatachannelBinaryDir({
        platform: "win32",
        packaged: true,
        resourcesPath: WIN_RESOURCES,
        appPath: `${WIN_RESOURCES}\\app.asar`,
        pathModule: path.win32,
      }),
    ).toBe(`${WIN_RESOURCES}\\app.asar.unpacked\\node_modules\\node-datachannel\\build\\Release`);
  });

  it("uses POSIX separators on Linux", () => {
    expect(
      nodeDatachannelBinaryDir({
        platform: "linux",
        packaged: true,
        resourcesPath: "/opt/VNBot/resources",
        appPath: "/opt/VNBot/resources/app.asar",
        pathModule: path.posix,
      }),
    ).toBe("/opt/VNBot/resources/app.asar.unpacked/node_modules/node-datachannel/build/Release");
  });

  it("has nothing to check in development", () => {
    expect(
      nodeDatachannelBinaryDir({
        platform: "win32",
        packaged: false,
        resourcesPath: WIN_RESOURCES,
        appPath: "C:\\src\\apps\\desktop",
      }),
    ).toBeNull();
  });
});

describe("hasNativeAddon", () => {
  it("accepts a directory holding a .node file", async () => {
    const list = async () => ["node_datachannel.node", "obj"];
    await expect(hasNativeAddon("dir", list)).resolves.toBe(true);
  });

  it("rejects a missing directory and a directory without an addon", async () => {
    await expect(
      hasNativeAddon("dir", async () => {
        throw new Error("ENOENT");
      }),
    ).resolves.toBe(false);
    await expect(hasNativeAddon("dir", async () => ["readme.txt"])).resolves.toBe(false);
  });
});

describe("p2pBundlePaths", () => {
  const layout = {
    platform: "win32",
    resourcesPath: WIN_RESOURCES,
    appPath: `${WIN_RESOURCES}\\app.asar`,
    pathModule: path.win32,
  };

  it("loads both bundles from the app archive", () => {
    expect(p2pBundlePaths({ ...layout, packaged: true })).toEqual({
      agent: `${WIN_RESOURCES}\\app.asar\\dist\\p2p-agent.js`,
      pairing: `${WIN_RESOURCES}\\app.asar\\dist\\p2p-pairing.js`,
    });
  });

  it("honours the development override only when not packaged", () => {
    const env = { [P2P_AGENT_MODULE_ENV]: "C:\\build\\p2p-agent.js" };
    expect(p2pBundlePaths({ ...layout, packaged: false, env })).toEqual({
      agent: "C:\\build\\p2p-agent.js",
      pairing: "C:\\build\\p2p-pairing.js",
    });
    expect(p2pBundlePaths({ ...layout, packaged: true, env }).agent).toBe(
      `${WIN_RESOURCES}\\app.asar\\dist\\p2p-agent.js`,
    );
  });
});

describe("parseGatewayUrl", () => {
  it("accepts https and loopback http and keeps only the origin", () => {
    expect(parseGatewayUrl(" https://gateway.example.test/ ")).toBe("https://gateway.example.test");
    expect(parseGatewayUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(parseGatewayUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("rejects plaintext remote hosts, other schemes and garbage", () => {
    expect(parseGatewayUrl("http://gateway.example.test")).toBeNull();
    expect(parseGatewayUrl("ftp://127.0.0.1")).toBeNull();
    expect(parseGatewayUrl("not a url")).toBeNull();
  });
});

describe("p2pUnavailableMessage", () => {
  it.each(["bad-gateway-url", "no-prebuild", "load-failed", "not-paired", "start-failed"] as const)(
    "%s carries Vietnamese and English",
    (reason) => {
      const [vi, en] = p2pUnavailableMessage(reason, "win32").split(" / ");
      expect(vi).toMatch(/[ăâđêôơưáàảãạ]/i);
      expect(en).toMatch(/^[A-Za-z]/);
    },
  );

  it("names the platform when the binary is missing", () => {
    expect(p2pUnavailableMessage("no-prebuild", "win32")).toContain("win32");
  });
});

function fakePairing(saved?: P2PNodeKeyFile) {
  let stored = saved;
  const completePairing = vi.fn(async () => ({ gatewayPublicKey: "gw-public", user: "user-1" }));
  const writeKeyFile = vi.fn((_file: string, identity: P2PNodeKeyFile) => {
    stored = identity;
  });
  const module: P2PPairingModule = {
    completePairing,
    generateKeyPair: () => ({ publicKey: "pub", privateKey: "priv" }),
    readKeyFile: () => stored,
    writeKeyFile,
  };
  return { module, completePairing, writeKeyFile };
}

type Reply = "started" | "error" | "exit";

/** A child that answers the start message with `reply` and exits on stop. */
function fakeChild(reply: Reply = "started") {
  const listeners = { message: [] as Array<(m: unknown) => void>, exit: [] as Array<() => void> };
  const sent: unknown[] = [];
  const child: P2PChild = {
    postMessage: (message) => {
      sent.push(message);
      const type = (message as { type: string }).type;
      queueMicrotask(() => {
        if (type === "start" && reply === "exit") for (const l of listeners.exit) l();
        else if (type === "start") for (const l of listeners.message) l({ type: reply });
        else if (type === "stop") for (const l of listeners.exit) l();
      });
    },
    on: ((event: "message" | "exit", listener: never) => {
      (listeners[event] as unknown[]).push(listener);
    }) as P2PChild["on"],
    kill: vi.fn(),
  };
  return {
    child,
    sent,
    crash: () => {
      for (const l of listeners.exit) l();
    },
    kill: child.kill,
  };
}

function node(
  options: {
    pairing?: ReturnType<typeof fakePairing> | null;
    child?: ReturnType<typeof fakeChild>;
  } = {},
  extra: Partial<ConstructorParameters<typeof P2PNode>[0]> = {},
  env: NodeJS.ProcessEnv = { [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787" },
) {
  const files = new Map<string, string>();
  const log = vi.fn();
  const spawnAgent = vi.fn(
    async (_entry: string, _env: Record<string, string>) => (options.child ?? fakeChild()).child,
  );
  const instance = new P2PNode({
    platform: "linux",
    packaged: false,
    resourcesPath: "/res",
    appPath: "/app",
    pathModule: path.posix,
    userDataDir: "/data",
    env,
    loadPairing: async () => {
      if (options.pairing === null) throw new Error("Cannot find module");
      return (options.pairing ?? fakePairing()).module;
    },
    spawnAgent,
    readText: async (file) => files.get(file) ?? null,
    writeText: async (file, text) => void files.set(file, text),
    ensureDir: async () => undefined,
    randomHex: () => "abcd1234abcd1234",
    log,
    ...extra,
  });
  return { instance, files, log, spawnAgent };
}

const SAVED: P2PNodeKeyFile = {
  publicKey: "pub",
  privateKey: "priv",
  gatewayPublicKey: "gw",
  user: "u",
};
const WEB = "http://127.0.0.1:4000";

describe("P2PNode", () => {
  it.each(["linux", "win32"])(
    "binds the registered %s machine to its local account session",
    async (platform) => {
      const child = fakeChild();
      const localSession = vi.fn(async () => ({ cookie: "local-session=fixture" }));
      const { instance } = node(
        {
          pairing: fakePairing({ ...SAVED, nodeId: "desktop-registered", localUser: "local-user" }),
          child,
        },
        { platform, localSession },
      );
      expect((await instance.start(WEB)).state).toBe("running");
      expect(localSession).toHaveBeenCalledWith("local-user");
      expect(child.sent[0]).toMatchObject({
        nodeId: "desktop-registered",
        localHeaders: { cookie: "local-session=fixture" },
      });
      await instance.stop();
    },
  );

  it("does not launch an agent when its local session was removed or changed", async () => {
    const { instance, spawnAgent } = node(
      { pairing: fakePairing({ ...SAVED, nodeId: "registered", localUser: "local-user" }) },
      {
        localSession: async () => {
          throw new Error("Signed out");
        },
      },
    );
    expect((await instance.start(WEB)).state).toBe("unavailable");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("a stop during local session validation prevents a stale agent launch", async () => {
    let resolve!: (headers: Record<string, string>) => void;
    const localSession = vi.fn(
      () =>
        new Promise<Record<string, string>>((done) => {
          resolve = done;
        }),
    );
    const { instance, spawnAgent } = node(
      { pairing: fakePairing({ ...SAVED, nodeId: "registered", localUser: "local-user" }) },
      { localSession },
    );
    const pending = instance.start(WEB);
    await vi.waitFor(() => expect(localSession).toHaveBeenCalled());
    await instance.stop();
    resolve({ cookie: "local-session=fixture" });
    expect((await pending).state).toBe("off");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("stays off without a gateway URL and spawns nothing", async () => {
    const { instance, log, spawnAgent } = node({}, {}, {});
    await expect(instance.start(WEB)).resolves.toEqual({ state: "off" });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("reads the gateway URL from saved settings when the environment has none", async () => {
    const child = fakeChild();
    const { instance, files } = node(
      { pairing: fakePairing(SAVED), child },
      { gatewayUrl: "https://gateway.example.test" },
      {},
    );
    files.set("/data/p2p/node-id", "desktop-1\n");
    await instance.start(WEB);
    expect(child.sent[0]).toMatchObject({
      type: "start",
      gatewayUrl: "https://gateway.example.test",
    });
  });

  it("turns P2P off with a message for a gateway that is not https", async () => {
    const { instance, spawnAgent } = node(
      {},
      {},
      { [P2P_GATEWAY_ENV]: "http://gateway.example.test" },
    );
    expect(await instance.start(WEB)).toMatchObject({
      state: "unavailable",
      reason: "bad-gateway-url",
    });
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  const WIN = {
    platform: "win32",
    packaged: true,
    resourcesPath: WIN_RESOURCES,
    appPath: `${WIN_RESOURCES}\\app.asar`,
    pathModule: path.win32,
  };

  it("reports a missing Windows prebuild without loading anything", async () => {
    const { instance, log, spawnAgent } = node(
      {},
      {
        ...WIN,
        list: async (dir) => {
          expect(dir).toBe(
            `${WIN_RESOURCES}\\app.asar.unpacked\\node_modules\\node-datachannel\\build\\Release`,
          );
          return [];
        },
      },
    );
    const status = await instance.start(WEB);
    expect(status).toMatchObject({ state: "unavailable", reason: "no-prebuild" });
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("node-datachannel"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("win32"));
  });

  it("goes on to pairing when the Windows prebuild is present", async () => {
    const { instance, spawnAgent } = node(
      { pairing: fakePairing(SAVED) },
      { ...WIN, list: async () => ["node_datachannel.node"] },
    );
    expect(await instance.start(WEB)).toMatchObject({ reason: "not-paired" });
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("reports a pairing bundle that fails to load instead of throwing", async () => {
    const { instance } = node({ pairing: null });
    expect(await instance.start(WEB)).toMatchObject({
      state: "unavailable",
      reason: "load-failed",
    });
  });

  it("reports a missing native library when the agent process exits at load", async () => {
    const { instance, files } = node({ pairing: fakePairing(SAVED), child: fakeChild("exit") });
    files.set("/data/p2p/node-id", "desktop-1\n");
    expect(await instance.start(WEB)).toMatchObject({ reason: "load-failed" });
  });

  it("reports an agent that refuses to start", async () => {
    const { instance, files } = node({ pairing: fakePairing(SAVED), child: fakeChild("error") });
    files.set("/data/p2p/node-id", "desktop-1\n");
    expect(await instance.start(WEB)).toMatchObject({ reason: "start-failed" });
  });

  it("gives up on an agent that never answers", async () => {
    const silent = fakeChild();
    silent.child.postMessage = () => undefined;
    const { instance, files } = node(
      { pairing: fakePairing(SAVED), child: silent },
      { startTimeoutMs: 20 },
    );
    files.set("/data/p2p/node-id", "desktop-1\n");
    expect(await instance.start(WEB)).toMatchObject({ reason: "start-failed" });
    expect(silent.kill).toHaveBeenCalled();
  });

  it("asks for a pairing code when the node has no saved key", async () => {
    const { instance } = node();
    expect(await instance.start(WEB)).toMatchObject({ reason: "not-paired" });
  });

  it("pairs once with the code, saves the identity and starts the agent", async () => {
    const pairing = fakePairing();
    const child = fakeChild();
    const { instance, files, log, spawnAgent } = node(
      { pairing, child },
      {},
      { [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787/", [P2P_PAIR_CODE_ENV]: "FAKE-CODE-123" },
    );
    const status = await instance.start(WEB);
    expect(status).toEqual({ state: "running", nodeId: "desktop-abcd1234abcd1234" });
    expect(pairing.completePairing).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "FAKE-CODE-123",
      "desktop-abcd1234abcd1234",
      { publicKey: "pub", privateKey: "priv" },
    );
    expect(pairing.writeKeyFile).toHaveBeenCalledWith(
      "/data/p2p/node-key.json",
      expect.objectContaining({ gatewayPublicKey: "gw-public", user: "user-1" }),
    );
    expect(files.get("/data/p2p/node-id")).toBe("desktop-abcd1234abcd1234\n");
    expect(spawnAgent).toHaveBeenCalledWith("/app/dist/p2p-agent.js", expect.any(Object));
    expect(child.sent[0]).toEqual({
      localHeaders: {},
      type: "start",
      gatewayUrl: "http://127.0.0.1:8787",
      nodeId: "desktop-abcd1234abcd1234",
      webUrl: WEB,
      key: { publicKey: "pub", privateKey: "priv", gatewayPublicKey: "gw-public", user: "user-1" },
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/FAKE-CODE|priv|gw-public/);

    await instance.stop();
    const again = node(
      { pairing, child: fakeChild() },
      {},
      { [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787" },
    );
    again.files.set("/data/p2p/node-id", "desktop-abcd1234abcd1234\n");
    await again.instance.start(WEB);
    expect(pairing.completePairing).toHaveBeenCalledTimes(1);
    expect(again.spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("gives the agent only a few environment variables", async () => {
    const { instance, files, spawnAgent } = node(
      { pairing: fakePairing(SAVED) },
      {},
      {
        [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787",
        PATH: "/bin",
        BETTER_AUTH_SECRET: "must-not-leak",
      },
    );
    files.set("/data/p2p/node-id", "desktop-1\n");
    await instance.start(WEB);
    expect(spawnAgent.mock.calls[0]?.[1]).toEqual({ PATH: "/bin" });
  });

  it("saves nothing when the gateway refuses the pairing", async () => {
    const pairing = fakePairing();
    pairing.completePairing.mockRejectedValueOnce(new Error("pair/complete failed: 403"));
    const { instance, files } = node(
      { pairing },
      {},
      { [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787", [P2P_PAIR_CODE_ENV]: "FAKE-CODE-123" },
    );
    expect(await instance.start(WEB)).toMatchObject({ reason: "start-failed" });
    expect(pairing.writeKeyFile).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("does not restart for the same web address and stops the child on stop", async () => {
    const child = fakeChild();
    const { instance, files, spawnAgent } = node({ pairing: fakePairing(SAVED), child });
    files.set("/data/p2p/node-id", "desktop-1\n");
    await instance.start(WEB);
    await instance.start(WEB);
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    await instance.stop();
    expect(child.sent.at(-1)).toEqual({ type: "stop" });
    expect(instance.status()).toEqual({ state: "off" });
  });

  it("reports the agent process dying while running", async () => {
    const child = fakeChild();
    const { instance, files, log } = node({ pairing: fakePairing(SAVED), child });
    files.set("/data/p2p/node-id", "desktop-1\n");
    await instance.start(WEB);
    child.crash();
    expect(instance.status()).toMatchObject({ state: "unavailable", reason: "start-failed" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("cổng P2P"));
  });
});
