import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_ASSETS,
  CONNECTOR_VERSION,
  ConnectorInstallError,
  resolveConnectorExecutable,
} from "./remote-connector-binary.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "connector-"));
  dirs.push(dir);
  return dir;
}

const binary = Buffer.from("pretend connector");
function serve(bytes: Buffer, status = 200) {
  return vi.fn(async () => new Response(new Uint8Array(bytes), { status }));
}

describe("resolveConnectorExecutable", () => {
  const sha = createHash("sha256").update(binary).digest("hex");
  const linux = { platform: "linux" as const, arch: "x64", searchPath: "" };
  const assets = CONNECTOR_ASSETS as Record<string, { file: string; sha256: string }>;
  const original = { ...assets["linux-x64"]! };
  afterEach(() => {
    assets["linux-x64"] = { ...original };
  });

  it("uses the operator's path as given", async () => {
    const probe = vi.fn();
    await expect(
      resolveConnectorExecutable({ toolsDir: "/x", override: " /opt/c ", probe }),
    ).resolves.toBe("/opt/c");
    expect(probe).not.toHaveBeenCalled();
  });

  it("downloads the pinned release once, checks it, and reuses the installed copy", async () => {
    assets["linux-x64"] = { file: "cloudflared-linux-amd64", sha256: sha };
    const toolsDir = await scratch();
    await mkdir(path.join(toolsDir, "cloudflared", "2025.1.0"), { recursive: true });
    const fetch = serve(binary);
    const probe = vi.fn(async () => CONNECTOR_VERSION);

    const first = await resolveConnectorExecutable({ ...linux, toolsDir, fetch, probe });
    expect(first).toBe(
      path.join(toolsDir, "cloudflared", CONNECTOR_VERSION, "linux-x64", "cloudflared"),
    );
    expect(await readFile(first)).toEqual(binary);
    expect(fetch).toHaveBeenCalledWith(
      `https://dl.vnbot.run/tools/cloudflared/${CONNECTOR_VERSION}/cloudflared-linux-amd64`,
      expect.anything(),
    );
    // Older versions this app installed are removed; no install scratch is left behind.
    expect(await readdir(path.join(toolsDir, "cloudflared"))).toEqual([CONNECTOR_VERSION]);
    expect(await readdir(path.dirname(first))).toEqual(["cloudflared"]);

    await resolveConnectorExecutable({ ...linux, toolsDir, fetch, probe });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("falls back to the next source when the first is down", async () => {
    assets["linux-x64"] = { file: "cloudflared-linux-amd64", sha256: sha };
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(new Uint8Array(binary)));
    const probe = async () => CONNECTOR_VERSION;
    await resolveConnectorExecutable({ ...linux, toolsDir: await scratch(), fetch, probe });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain("github.com/cloudflare/cloudflared");
  });

  it("refuses a download whose checksum does not match, and never runs it", async () => {
    const toolsDir = await scratch();
    const probe = vi.fn(async () => CONNECTOR_VERSION);
    const result = resolveConnectorExecutable({
      ...linux,
      toolsDir,
      fetch: serve(Buffer.from("something else")),
      probe,
    });
    await expect(result).rejects.toThrow("did not match its checksum");
    expect(probe).not.toHaveBeenCalled();
    expect(await readdir(toolsDir)).toEqual([]);
  });

  it("reports a clear error when every source is unreachable", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = resolveConnectorExecutable({ ...linux, toolsDir: await scratch(), fetch });
    await expect(result).rejects.toBeInstanceOf(ConnectorInstallError);
    await expect(result).rejects.toThrow("Could not download the remote access connector.");
  });

  it("refuses a download that does not run as the pinned version", async () => {
    assets["linux-x64"] = { file: "cloudflared-linux-amd64", sha256: sha };
    const toolsDir = await scratch();
    const result = resolveConnectorExecutable({
      ...linux,
      toolsDir,
      fetch: serve(binary),
      probe: async () => null,
    });
    await expect(result).rejects.toThrow("did not run");
    expect(
      await readdir(path.join(toolsDir, "cloudflared", CONNECTOR_VERSION, "linux-x64")),
    ).toEqual([]);
  });

  it("uses a connector already on the computer instead of downloading", async () => {
    const bin = await scratch();
    await writeFile(path.join(bin, "cloudflared"), "x");
    const fetch = vi.fn();
    const found = await resolveConnectorExecutable({
      ...linux,
      searchPath: bin,
      toolsDir: await scratch(),
      fetch,
      probe: async () => "2025.8.0",
    });
    expect(found).toBe(path.join(bin, "cloudflared"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says when this computer has no release to download", async () => {
    await expect(
      resolveConnectorExecutable({
        platform: "freebsd",
        arch: "x64",
        searchPath: "",
        toolsDir: "/x",
      }),
    ).rejects.toThrow("not available on freebsd-x64");
  });

  it("pins every desktop platform", () => {
    expect(Object.keys(CONNECTOR_ASSETS).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);
    for (const asset of Object.values(CONNECTOR_ASSETS))
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
