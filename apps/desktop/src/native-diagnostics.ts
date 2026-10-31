import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./setup-store.js";

export const NATIVE_STACK_LOG_DIR = "logs";
export const NATIVE_STACK_LOG_FILE = "native-stack.log";
const MAX_MESSAGE_CHARS = 400;
const MAX_CAUSES = 4;
const MAX_LOG_BYTES = 256 * 1024;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|key|auth|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
/** Long opaque runs are hex digests, base64 or key material; none belongs in a log. */
const OPAQUE_PATTERN = /\b[A-Za-z0-9+/_-]{24,}={0,2}/g;

/**
 * Strips URLs (database and web addresses), passwords, tokens and long opaque strings
 * so a failure can be pasted into a bug report. Pass the user data directory to also
 * hide the account name inside local paths.
 */
export function redactDiagnostic(message: string, hidePaths: readonly string[] = []): string {
  let text = message;
  for (const hidden of hidePaths) if (hidden) text = text.split(hidden).join("<userData>");
  text = text
    .replace(URL_PATTERN, "<url>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(ASSIGNMENT_PATTERN, (_all, name: string, sep: string) => `${name}${sep}<redacted>`)
    .replace(OPAQUE_PATTERN, "<redacted>")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
}

/** One line per error in the cause chain: its class and redacted message. */
export function describeFailure(
  stage: string,
  error: unknown,
  hidePaths: readonly string[] = [],
): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSES && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${redactDiagnostic(current.message, hidePaths)}`);
      current = current.cause;
    } else {
      parts.push(`non-error: ${redactDiagnostic(String(current), hidePaths)}`);
      current = undefined;
    }
  }
  return `stage=${stage} ${parts.join(" <- ") || "unknown"}`;
}

export interface NativeFailureLogInput {
  userDataDir: string;
  stage: string;
  error: unknown;
  debug?: boolean;
  now?: () => Date;
  stderr?: (line: string) => void;
  refusal?: { code: string; messageVi: string };
  stdout?: (line: string) => void;
}

/** Appends to `<userData>/logs/native-stack.log` (owner-only) and, in debug mode, to stderr. */
export async function logNativeFailure(input: NativeFailureLogInput): Promise<void> {
  if (input.refusal?.code.startsWith("data-dir-")) {
    (input.stdout ?? ((text) => process.stdout.write(`${text}\n`)))(
      `${input.refusal.code} ${input.refusal.messageVi}`,
    );
  }
  const line = `${(input.now ?? (() => new Date()))().toISOString()} ${describeFailure(
    input.stage,
    input.error,
    [input.userDataDir],
  )}`;
  if (input.debug) (input.stderr ?? ((text) => process.stderr.write(`${text}\n`)))(line);
  try {
    const dir = path.join(input.userDataDir, NATIVE_STACK_LOG_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, NATIVE_STACK_LOG_FILE);
    // Create the file private first; appends then keep its mode.
    await appendFile(file, "", { mode: 0o600 }).catch(() => undefined);
    const { size } = await stat(file);
    if (size > MAX_LOG_BYTES) await writePrivateFile(file, `${line}\n`);
    else await appendFile(file, `${line}\n`, { mode: 0o600 });
  } catch {
    /* Diagnostics must never turn a failed start into a crash. */
  }
}
