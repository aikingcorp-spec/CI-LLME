import { mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultUserDataDir } from "./native-postgres.js";
import { writePrivateFile } from "./setup-store.js";

export function nativeWebUrlFile(input: {
  userDataDir?: string;
  platform: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
  pathModule: typeof path;
}): string {
  const root = input.userDataDir ?? defaultUserDataDir({ ...input, path: input.pathModule });
  return input.pathModule.join(root, "stack", ".desktop-web-url");
}

export async function writeNativeWebUrl(userDataDir: string, webUrl: string): Promise<void> {
  if (
    !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(webUrl) ||
    Number(new URL(webUrl).port) > 65535 ||
    Number(new URL(webUrl).port) < 1024
  )
    throw new Error("Invalid local web address.");
  const dir = path.join(userDataDir, "stack");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writePrivateFile(path.join(dir, ".desktop-web-url"), webUrl);
}

/** Fixed failure text prevents child errors, credentials and local paths reaching logs. */
export async function runNativeSmoke(input: {
  stack: { start(): Promise<{ webUrl?: string }>; stop(): Promise<void> };
  userDataDir: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
}): Promise<0 | 1> {
  let result: 0 | 1 = 1;
  let message = "RAKAZO_DESKTOP_SMOKE fail startup";
  try {
    const { webUrl } = await input.stack.start();
    if (!webUrl) throw new Error("Missing web address");
    await writeNativeWebUrl(input.userDataDir, webUrl);
    const response = await (input.fetch ?? fetch)(`${webUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 200) {
      result = 0;
      message = `RAKAZO_DESKTOP_SMOKE ok ${webUrl}`;
    } else message = "RAKAZO_DESKTOP_SMOKE fail health";
  } catch {
    /* Sanitized failure above. */
  }
  try {
    await input.stack.stop();
  } catch {
    result = 1;
    message = "RAKAZO_DESKTOP_SMOKE fail shutdown";
  }
  (input.print ?? console.log)(message);
  return result;
}
