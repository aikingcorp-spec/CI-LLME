import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { P2PAgentModule, P2PNodeKeyFile } from "./p2p-node.js";
import {
  desktopChannelHandler,
  hasNativeAddon,
  nodeDatachannelBinaryDir,
  P2P_AGENT_MODULE_ENV,
  P2P_GATEWAY_ENV,
  P2P_PAIR_CODE_ENV,
  P2PNode,
  p2pAgentModulePath,
  p2pUnavailableMessage,
  parseGatewayUrl,
} from "./p2p-node.js";

const WIN_RESOURCES = "C:\\Users\\Ada\\AppData\\Local\\Programs\\VNBot\\resources";

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

describe("p2pAgentModulePath", () => {
  const layout = {
    platform: "win32",
    resourcesPath: WIN_RESOURCES,
    appPath: `${WIN_RESOURCES}\\app.asar`,
    pathModule: path.win32,
  };

  it("loads the bundle from the app archive", () => {
    expect(p2pAgentModulePath({ ...layout, packaged: true })).toBe(
      `${WIN_RESOURCES}\\app.asar\\dist\\p2p-agent.js`,
    );
  });

  it("honours the development override only when not packaged", () => {
    const env = { [P2P_AGENT_MODULE_ENV]: "/tmp/agent.js" };
    expect(p2pAgentModulePath({ ...layout, packaged: false, env })).toBe("/tmp/agent.js");
    expect(p2pAgentModulePath({ ...layout, packaged: true, env })).toBe(
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

describe("desktopChannelHandler", () => {
  const rpc = () => ({
    call: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array([1]) })),
    subscribe: vi.fn(async function* () {
      yield new Uint8Array([2]);
    }),
  });

  it("answers health from GET /health and forwards everything else to rpc", async () => {
    const forward = rpc();
    const request = vi.fn(async () => new Response("ok", { status: 200 }));
    const handler = desktopChannelHandler("http://127.0.0.1:4000", forward, request);
    const health = await handler.call("health", {}, new Uint8Array());
    expect(new TextDecoder().decode(health.body)).toBe("ok");
    expect(request).toHaveBeenCalledWith(new URL("http://127.0.0.1:4000/health"), {
      method: "GET",
    });
    expect(forward.call).not.toHaveBeenCalled();
    await handler.call("threads/list", {}, new Uint8Array());
    expect(forward.call).toHaveBeenCalledWith("threads/list", {}, new Uint8Array());
    for await (const _ of handler.subscribe(
      "x",
      {},
      new Uint8Array(),
      new AbortController().signal,
    ));
    expect(forward.subscribe).toHaveBeenCalledTimes(1);
  });
});

function fakeAgent(saved?: P2PNodeKeyFile) {
  let stored = saved;
  const close = vi.fn(async () => undefined);
  const startNodeAgent = vi.fn(() => ({ close, connected: () => true }));
  const completePairing = vi.fn(async () => ({ gatewayPublicKey: "gw-public", user: "user-1" }));
  const writeKeyFile = vi.fn((_file: string, identity: P2PNodeKeyFile) => {
    stored = identity;
  });
  const module: P2PAgentModule = {
    startNodeAgent,
    completePairing,
    generateKeyPair: () => ({ publicKey: "pub", privateKey: "priv" }),
    readKeyFile: () => stored,
    writeKeyFile,
    forwardChannelHandler: () => ({
      call: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
      subscribe: async function* () {},
    }),
  };
  return { module, close, startNodeAgent, completePairing, writeKeyFile };
}

function node(
  agent: ReturnType<typeof fakeAgent> | null,
  extra: Partial<ConstructorParameters<typeof P2PNode>[0]> = {},
  env: NodeJS.ProcessEnv = { [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787" },
) {
  const files = new Map<string, string>();
  const log = vi.fn();
  const instance = new P2PNode({
    platform: "linux",
    packaged: false,
    resourcesPath: "/res",
    appPath: "/app",
    pathModule: path.posix,
    userDataDir: "/data",
    env,
    loadAgent: async () => {
      if (!agent) throw new Error("Cannot find module");
      return agent.module;
    },
    readText: async (file) => files.get(file) ?? null,
    writeText: async (file, text) => void files.set(file, text),
    ensureDir: async () => undefined,
    randomHex: () => "abcd1234abcd1234",
    log,
    ...extra,
  });
  return { instance, files, log };
}

describe("P2PNode", () => {
  it("stays off without a gateway URL and never loads the agent", async () => {
    const loadAgent = vi.fn();
    const { instance, log } = node(null, { loadAgent }, {});
    await expect(instance.start("http://127.0.0.1:4000")).resolves.toEqual({ state: "off" });
    expect(loadAgent).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("reads the gateway URL from saved settings when the environment has none", async () => {
    const agent = fakeAgent({
      publicKey: "pub",
      privateKey: "priv",
      gatewayPublicKey: "gw",
      user: "u",
    });
    const { instance, files } = node(agent, { gatewayUrl: "https://gateway.example.test" }, {});
    files.set("/data/p2p/node-id", "desktop-1\n");
    await instance.start("http://127.0.0.1:4000");
    expect(agent.startNodeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayUrl: "https://gateway.example.test" }),
    );
  });

  it("turns P2P off with a message for a gateway that is not https", async () => {
    const { instance } = node(null, {}, { [P2P_GATEWAY_ENV]: "http://gateway.example.test" });
    expect(await instance.start("http://127.0.0.1:4000")).toMatchObject({
      state: "unavailable",
      reason: "bad-gateway-url",
    });
  });

  it("reports a missing Windows prebuild without loading the agent", async () => {
    const loadAgent = vi.fn();
    const { instance, log } = node(null, {
      platform: "win32",
      packaged: true,
      resourcesPath: WIN_RESOURCES,
      appPath: `${WIN_RESOURCES}\\app.asar`,
      pathModule: path.win32,
      list: async (dir) => {
        expect(dir).toBe(
          `${WIN_RESOURCES}\\app.asar.unpacked\\node_modules\\node-datachannel\\build\\Release`,
        );
        return [];
      },
      loadAgent,
    });
    const status = await instance.start("http://127.0.0.1:4000");
    expect(status).toMatchObject({ state: "unavailable", reason: "no-prebuild" });
    expect(loadAgent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("node-datachannel"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("win32"));
  });

  it("goes on to load the agent when the Windows prebuild is present", async () => {
    const agent = fakeAgent();
    const { instance } = node(agent, {
      platform: "win32",
      packaged: true,
      resourcesPath: WIN_RESOURCES,
      appPath: `${WIN_RESOURCES}\\app.asar`,
      pathModule: path.win32,
      list: async () => ["node_datachannel.node"],
    });
    expect(await instance.start("http://127.0.0.1:4000")).toMatchObject({ reason: "not-paired" });
  });

  it("reports a library that fails to load instead of throwing", async () => {
    const { instance } = node(null);
    expect(await instance.start("http://127.0.0.1:4000")).toMatchObject({
      state: "unavailable",
      reason: "load-failed",
    });
  });

  it("asks for a pairing code when the node has no saved key", async () => {
    const { instance } = node(fakeAgent());
    expect(await instance.start("http://127.0.0.1:4000")).toMatchObject({ reason: "not-paired" });
  });

  it("pairs once with the code, saves the identity and starts the agent", async () => {
    const agent = fakeAgent();
    const { instance, files, log } = node(
      agent,
      {},
      {
        [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787/",
        [P2P_PAIR_CODE_ENV]: "FAKE-CODE-123",
      },
    );
    const status = await instance.start("http://127.0.0.1:4000");
    expect(status).toEqual({ state: "running", nodeId: "desktop-abcd1234abcd1234" });
    expect(agent.completePairing).toHaveBeenCalledWith(
      "http://127.0.0.1:8787",
      "FAKE-CODE-123",
      "desktop-abcd1234abcd1234",
      { publicKey: "pub", privateKey: "priv" },
    );
    expect(agent.writeKeyFile).toHaveBeenCalledWith(
      "/data/p2p/node-key.json",
      expect.objectContaining({ gatewayPublicKey: "gw-public", user: "user-1" }),
    );
    expect(files.get("/data/p2p/node-id")).toBe("desktop-abcd1234abcd1234\n");
    expect(agent.startNodeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "http://127.0.0.1:8787",
        nodeId: "desktop-abcd1234abcd1234",
        channel: expect.objectContaining({ allowedUsers: ["user-1"] }),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/FAKE-CODE|priv|gw-public/);

    await instance.stop();
    const again = node(agent, {}, { [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787" });
    again.files.set("/data/p2p/node-id", "desktop-abcd1234abcd1234\n");
    await again.instance.start("http://127.0.0.1:4000");
    expect(agent.completePairing).toHaveBeenCalledTimes(1);
    expect(agent.startNodeAgent).toHaveBeenCalledTimes(2);
  });

  it("saves nothing when the gateway refuses the pairing", async () => {
    const agent = fakeAgent();
    agent.completePairing.mockRejectedValueOnce(new Error("pair/complete failed: 403"));
    const { instance, files } = node(
      agent,
      {},
      {
        [P2P_GATEWAY_ENV]: "http://127.0.0.1:8787",
        [P2P_PAIR_CODE_ENV]: "FAKE-CODE-123",
      },
    );
    expect(await instance.start("http://127.0.0.1:4000")).toMatchObject({
      reason: "start-failed",
    });
    expect(agent.writeKeyFile).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("does not restart for the same web address and closes the agent on stop", async () => {
    const agent = fakeAgent({
      publicKey: "pub",
      privateKey: "priv",
      gatewayPublicKey: "gw",
      user: "u",
    });
    const { instance, files } = node(agent);
    files.set("/data/p2p/node-id", "desktop-1\n");
    await instance.start("http://127.0.0.1:4000");
    await instance.start("http://127.0.0.1:4000");
    expect(agent.startNodeAgent).toHaveBeenCalledTimes(1);
    expect(instance.connected()).toBe(true);
    await instance.stop();
    expect(agent.close).toHaveBeenCalledTimes(1);
    expect(instance.status()).toEqual({ state: "off" });
    expect(instance.connected()).toBe(false);
  });
});
