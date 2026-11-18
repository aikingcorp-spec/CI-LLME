export type NativeBuildRequest = {
  platform: NodeJS.Platform;
  arch: string;
  nodeBinary: string;
  postgresPrefix: string;
  output: string;
  repoRoot: string;
};

export function nativeBuildDefaults(): {
  platform: NodeJS.Platform;
  arch: string;
  output: string;
  repoRoot: string;
};

export function parseNativeBuildArgs(
  argv: readonly string[],
  defaults?: {
    platform?: NodeJS.Platform;
    arch?: string;
    output?: string;
    repoRoot?: string;
  },
): NativeBuildRequest;

export function assembleNativeBundle(input: {
  platform: NodeJS.Platform;
  arch: string;
  nodeBinary: string;
  postgresPrefix: string;
  output: string;
  repoRoot: string;
}): Promise<string>;

export function vendorWindowsRuntimeDlls(
  binaryDirectory: string,
  libraryDirectory: string,
  searchDirs: readonly string[],
): Promise<void>;
