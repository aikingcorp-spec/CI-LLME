import { DESKTOP_DOWNLOAD_URL } from "@rakazo/contracts";

export interface DesktopDownload {
  version: string;
  url: string;
}

export interface DesktopDownloads {
  windows: DesktopDownload | null;
  mac: DesktopDownload | null;
  linuxDeb: DesktopDownload | null;
  linuxAppImage: DesktopDownload | null;
}

const CACHE_MS = 5 * 60_000;

/** The `version` and every file `url` of an update feed. Plain lines; no YAML library needed. */
export function parseFeed(text: string): { version: string | null; files: string[] } {
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(text)?.[1] ?? null;
  const files = [...text.matchAll(/^\s*-\s*url:\s*['"]?([^'"\s]+)/gm)].map((match) => match[1]!);
  return { version, files };
}

/**
 * The installers the update feeds offer now, read from the feeds the desktop app updates from,
 * so the page never names a build the app would not install. Each system rolls out on its own.
 */
export function desktopDownloads(
  fetchImpl: typeof fetch = fetch,
  base: string = DESKTOP_DOWNLOAD_URL,
  now: () => number = Date.now,
): () => Promise<DesktopDownloads> {
  let cached: { at: number; value: DesktopDownloads } | null = null;
  const read = async (name: string) => {
    const response = await fetchImpl(`${base}/${name}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Feed ${name} answered ${response.status}`);
    return parseFeed(await response.text());
  };
  const pick = (feed: { version: string | null; files: string[] }, suffix: string) => {
    const file = feed.files.find((name) => name.endsWith(suffix));
    if (!feed.version || !file || file.includes("/") || file.includes("..")) return null;
    return { version: feed.version, url: `${base}/${file}` };
  };
  return async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    const [windows, mac, linux] = await Promise.all([
      read("latest.yml"),
      read("latest-mac.yml"),
      read("latest-linux.yml"),
    ]);
    const value = {
      windows: pick(windows, ".exe"),
      mac: pick(mac, ".dmg"),
      linuxDeb: pick(linux, ".deb"),
      linuxAppImage: pick(linux, ".AppImage"),
    };
    cached = { at: now(), value };
    return value;
  };
}
