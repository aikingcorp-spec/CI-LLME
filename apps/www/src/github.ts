import { PRODUCT_DESKTOP_URL } from "./site";

export type DesktopDownloads = Partial<Record<"mac" | "windows" | "linux", string>>;

export type RecentChange = { title: string; pr: string | null; url: string; date: string };

/** No star count. The old fallback of 6000 was not a measurement of this product. */
export async function githubStarsLabel(): Promise<string> {
  return "";
}

function isPublishedInstaller(value: string | undefined): value is string {
  if (!value?.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    return url.hostname !== "github.com" && url.hostname !== "objects.githubusercontent.com";
  } catch {
    return false;
  }
}

/** Platforms that already have an https installer outside GitHub. A missing feed adds none. */
export function availableDesktopPlatforms(downloads: DesktopDownloads) {
  return (["mac", "windows", "linux"] as const).filter((platform) =>
    isPublishedInstaller(downloads[platform]),
  );
}

/** Directory of VNBot desktop installers. Not a file for one operating system. */
export function desktopDownloadHref(_platform: keyof DesktopDownloads): string {
  return PRODUCT_DESKTOP_URL;
}

/** GitHub releases are not an approved VNBot install feed. */
export async function fetchDesktopDownloads(
  _fetchImpl: typeof fetch = fetch,
): Promise<DesktopDownloads> {
  return {};
}

/** Upstream commit subjects are not VNBot release notes. */
export async function fetchRecentChanges(
  _limit: number,
  _fetchImpl: typeof fetch = fetch,
): Promise<RecentChange[]> {
  return [];
}
