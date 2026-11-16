import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** The connector release this app installs and checks for; its downloads are pinned below. */
export const CONNECTOR_VERSION = "2026.10.4";

const RELEASE = `https://github.com/cloudflare/cloudflared/releases/download/${CONNECTOR_VERSION}`;
const MIRROR = `https://dl.vnbot.run/tools/cloudflared/${CONNECTOR_VERSION}`;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

type Asset = { file: string; sha256: string; archive?: "tgz" };

/** Release files by `platform-arch`, with the SHA-256 each download must match. */
export const CONNECTOR_ASSETS: Readonly<Record<string, Asset>> = {
  "darwin-arm64": {
    file: "cloudflared-darwin-arm64.tgz",
    sha256: "68b6bc4080ac1330234db2a9002d07f98b000537a1bd531a687b660d4160fa7f",
    archive: "tgz",
  },
  "darwin-x64": {
    file: "cloudflared-darwin-amd64.tgz",
    sha256: "f11fbef4207d715892331917dafd437f032cf4b7137ed64dea3008338c1c613d",
    archive: "tgz",
  },
  "linux-arm64": {
    file: "cloudflared-linux-arm64",
    sha256: "2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6",
  },
  "linux-x64": {
    file: "cloudflared-linux-amd64",
    sha256: "ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42",
  },
  // Windows on Arm runs the x64 build.
  "win32-x64": {
    file: "cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
  },
  "win32-arm64": {
    file: "cloudflared-windows-amd64.exe",
    sha256: "411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8",
  },
};

export class ConnectorInstallError extends Error {
  override name = "ConnectorInstallError";
}

export type ConnectorBinaryDeps = {
  /** Where installed tools live: `<toolsDir>/cloudflared/<version>/<platform-arch>/`. */
  toolsDir: string;
  /** A path the operator chose. It is used as given. */
  override?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Directories searched for an installed connector, PATH by default. */
  searchPath?: string;
  fetch?: typeof fetch;
  /** The connector's version, or null when the file does not run as one. */
  probe?: (executable: string) => Promise<string | null>;
  extract?: (archive: string, directory: string) => Promise<void>;
  sources?: readonly string[];
};

const run = promisify(execFile);

async function probeVersion(executable: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(executable, ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return /version (\d+\.\d+\.\d+)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function extractTgz(archive: string, directory: string): Promise<void> {
  await run("tar", ["-xzf", archive, "-C", directory], { timeout: PROBE_TIMEOUT_MS });
}

async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

function executableName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

async function onSearchPath(
  searchPath: string,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const name = executableName(platform);
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

async function download(
  asset: Asset,
  sources: readonly string[],
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  let failure: unknown;
  for (const source of sources) {
    try {
      const response = await fetchImpl(`${source}/${asset.file}`, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`download returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      // A wrong file from one source never runs; the next source may still have the right one.
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
        throw new ConnectorInstallError("The remote access download did not match its checksum.");
      return bytes;
    } catch (error) {
      failure = error;
    }
  }
  if (failure instanceof ConnectorInstallError) throw failure;
  throw new ConnectorInstallError("Could not download the remote access connector.", {
    cause: failure,
  });
}

/**
 * The connector to run: the operator's choice, then the copy this app installed, then one already
 * on the computer, and otherwise the pinned release, downloaded once into `toolsDir` and checked
 * against its SHA-256 and version before it is used.
 */
export async function resolveConnectorExecutable(deps: ConnectorBinaryDeps): Promise<string> {
  if (deps.override?.trim()) return deps.override.trim();
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const probe = deps.probe ?? probeVersion;
  const root = path.join(deps.toolsDir, "cloudflared");
  const directory = path.join(root, CONNECTOR_VERSION, `${platform}-${arch}`);
  const managed = path.join(directory, executableName(platform));
  if ((await isFile(managed)) && (await probe(managed)) === CONNECTOR_VERSION) return managed;

  const installed = await onSearchPath(deps.searchPath ?? process.env.PATH ?? "", platform);
  if (installed && (await probe(installed)) !== null) return installed;

  const asset = CONNECTOR_ASSETS[`${platform}-${arch}`];
  if (!asset)
    throw new ConnectorInstallError(`Remote access is not available on ${platform}-${arch}.`);
  const bytes = await download(asset, deps.sources ?? [MIRROR, RELEASE], deps.fetch ?? fetch);

  await mkdir(directory, { recursive: true });
  const staging = path.join(directory, `.install-${randomUUID()}`);
  await mkdir(staging);
  try {
    const unpacked = path.join(staging, executableName(platform));
    if (asset.archive === "tgz") {
      const archive = path.join(staging, "cloudflared.tgz");
      await writeFile(archive, bytes);
      await (deps.extract ?? extractTgz)(archive, staging);
    } else {
      await writeFile(unpacked, bytes);
    }
    if (platform !== "win32") await chmod(unpacked, 0o755);
    const version = await probe(unpacked);
    if (version !== CONNECTOR_VERSION)
      throw new ConnectorInstallError("The downloaded remote access connector did not run.");
    await rename(unpacked, managed);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await pruneOtherVersions(root);
  return managed;
}

async function pruneOtherVersions(root: string): Promise<void> {
  const versions = await readdir(root).catch(() => [] as string[]);
  await Promise.all(
    versions
      .filter((version) => version !== CONNECTOR_VERSION)
      .map((version) => rm(path.join(root, version), { recursive: true, force: true })),
  );
}
