export function nativeBundleFiles(platform?: NodeJS.Platform): string[];

export function nativeBundleManifest(input: { platform: NodeJS.Platform; arch: string }): {
  version: 1;
  platform: NodeJS.Platform;
  arch: string;
  postgresMajor: 18;
  files: Record<string, true>;
};

export function isNativePostgresVersion(text: string): boolean;

export const WINDOWS_LINKS_FILE: "windows-links.json";
