import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultUserDataDir, PG_DIR_NAME } from "./native-postgres.js";
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

const SMOKE_LOG_LINES = 40;

async function printPostgresLogTail(input: {
  userDataDir: string;
  printError?: (line: string) => void;
  readPostgresLog?: () => Promise<string>;
}) {
  const text = await (
    input.readPostgresLog ??
    (() => readFile(path.join(input.userDataDir, PG_DIR_NAME, "postgres.log"), "utf8"))
  )().catch(() => "");
  const lines = postgresLogTail(text);
  if (lines.length === 0) return;
  const print = input.printError ?? ((line: string) => void process.stderr.write(`${line}\n`));
  print("RAKAZO_DESKTOP_SMOKE postgres-log-tail");
  for (const line of lines) print(line);
}

/** Stage markers go to stderr so a hung run still shows how far it got. Unset outside smoke mode. */
export function smokeStageReporter(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): ((stage: string) => void) | undefined {
  if (env.RAKAZO_DESKTOP_SMOKE !== "1") return undefined;
  return (stage) => write(`RAKAZO_DESKTOP_SMOKE stage=${stage}`);
}

/** The server log can echo a failed statement, so credentials and URLs are masked before printing. */
export function redactLogLine(line: string): string {
  return line
    .replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '***'")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***")
    .replace(/\b[a-f0-9]{32,}\b/gi, "***");
}

export function postgresLogTail(text: string, lines = SMOKE_LOG_LINES): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .map(redactLogLine);
}

/** Fixed failure text prevents child errors, credentials and local paths reaching logs. */
export async function runNativeSmoke(input: {
  stack: { start(): Promise<{ webUrl?: string }>; stop(): Promise<void> };
  userDataDir: string;
  fetch?: typeof fetch;
  print?: (line: string) => void;
  onStage?: (stage: string) => void;
  /** Where the redacted server log tail goes on failure. */
  printError?: (line: string) => void;
  readPostgresLog?: () => Promise<string>;
}): Promise<0 | 1> {
  let result: 0 | 1 = 1;
  let message = "RAKAZO_DESKTOP_SMOKE fail startup";
  try {
    const { webUrl } = await input.stack.start();
    if (!webUrl) throw new Error("Missing web address");
    input.onStage?.("health");
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
  if (result !== 0) await printPostgresLogTail(input);
  (input.print ?? console.log)(message);
  return result;
}
