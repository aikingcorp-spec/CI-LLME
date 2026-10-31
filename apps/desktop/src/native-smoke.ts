import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ensureLocalNodeSession } from "./local-node-session.js";
import { defaultUserDataDir, PG_DIR_NAME } from "./native-postgres.js";
import { readNativeStackToken } from "./native-services.js";
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
  startOffset: number;
}) {
  const text = await (
    input.readPostgresLog ??
    (() => readFile(path.join(input.userDataDir, PG_DIR_NAME, "postgres.log"), "utf8"))
  )().catch(() => "");
  const lines = postgresLogTail(
    text.slice(text.length < input.startOffset ? 0 : input.startOffset),
  );
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

/**
 * A healthy API is not yet a usable node: the sign-in screen must be served and the auth server
 * must say which sign-in it offers. Names the failing check, never a server message.
 */
async function signInSurfaceFailure(
  webUrl: string,
  call: typeof fetch,
): Promise<"capabilities" | "sign-in-page" | null> {
  const signal = () => AbortSignal.timeout(10_000);
  const capabilities = await call(`${webUrl}/api/auth/capabilities`, { signal: signal() });
  if (!capabilities.ok) return "capabilities";
  const body = (await capabilities.json()) as { emailCode?: unknown } | null;
  if (typeof body?.emailCode !== "boolean") return "capabilities";
  const page = await call(`${webUrl}/sign-in`, { signal: signal() });
  if (page.status !== 200 || !page.headers.get("content-type")?.includes("text/html"))
    return "sign-in-page";
  return null;
}

/** The real path behind "this computer": the private token opens a session the node then honours. */
async function localSessionFailure(
  webUrl: string,
  token: string | null,
  call: typeof fetch,
): Promise<"local-session" | null> {
  if (token === null) return "local-session";
  const email = "smoke@example.com";
  let cookie = "";
  await ensureLocalNodeSession({
    origin: webUrl,
    token,
    email,
    request: call,
    cookies: {
      get: async () => [],
      set: async ({ name, value }) => {
        cookie = `${name}=${value}`;
      },
    },
  });
  const session = await call(`${webUrl}/api/auth/get-session`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await session.json()) as { user?: { email?: unknown } } | null;
  return body?.user?.email === email ? null : "local-session";
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
  readStackToken?: (userDataDir: string) => Promise<string | null>;
}): Promise<0 | 1> {
  const logFile = path.join(input.userDataDir, PG_DIR_NAME, "postgres.log");
  const startOffset = (await stat(logFile).catch(() => null))?.size ?? 0;
  let result: 0 | 1 = 1;
  let message = "RAKAZO_DESKTOP_SMOKE fail startup";
  try {
    const { webUrl } = await input.stack.start();
    if (!webUrl) throw new Error("Missing web address");
    input.onStage?.("health");
    await writeNativeWebUrl(input.userDataDir, webUrl);
    const call = input.fetch ?? fetch;
    const response = await call(`${webUrl}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 200) {
      input.onStage?.("sign-in");
      const failure =
        (await signInSurfaceFailure(webUrl, call)) ??
        (await localSessionFailure(
          webUrl,
          await (input.readStackToken ?? readNativeStackToken)(input.userDataDir),
          call,
        ));
      if (failure === null) {
        result = 0;
        message = `RAKAZO_DESKTOP_SMOKE ok ${webUrl}`;
      } else message = `RAKAZO_DESKTOP_SMOKE fail ${failure}`;
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
  if (result !== 0) await printPostgresLogTail({ ...input, startOffset });
  (input.print ?? console.log)(message);
  return result;
}
