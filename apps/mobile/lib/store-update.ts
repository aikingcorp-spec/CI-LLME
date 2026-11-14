import { Linking } from "react-native";

const STORE_LOOKUP_URL = "https://itunes.apple.com/lookup";

/** True when dotted version `latest` is ahead of `current`; false when either is unreadable. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) =>
    /^\d+(\.\d+)*$/.test(value) ? value.split(".").map(Number) : null;
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff > 0;
  }
  return false;
}

/** The version the App Store currently offers for this app, or null when it cannot say. */
export async function fetchStoreVersion(bundleId: string): Promise<string | null> {
  const response = await fetch(
    `${STORE_LOOKUP_URL}?bundleId=${encodeURIComponent(bundleId)}&_=${Date.now()}`,
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { results?: Array<{ version?: unknown }> };
  const version = body.results?.[0]?.version;
  return typeof version === "string" ? version : null;
}

/** No VNBot store listing exists, so this never offers the upstream app. */
export function useStoreUpdateAvailable(): boolean {
  return false;
}

export function openStoreListing(): void {
  void Linking.openURL("https://app.vnbot.run").catch(() => undefined);
}
