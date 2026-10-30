/**
 * Which shell commands on the user's own computer need a person's approval first.
 *
 * Pure text analysis, no file system access: a command is split into segments and tokens
 * (quotes, escapes, pipes, nested shells, command substitution, PowerShell encoded commands),
 * and each token that names a path is resolved against the bot's workspace. Anything the
 * analysis cannot resolve (an unknown variable, a substitution) counts as outside the
 * workspace, so a doubt asks. It lowers risk; it is not a sandbox.
 */

export type HostCommandRisk =
  | "delete_outside_workspace"
  | "privilege_elevation"
  | "secret_access"
  | "remote_script"
  | "system_destroy"
  | "opaque_command";

export const HOST_COMMAND_RISKS: readonly HostCommandRisk[] = [
  "delete_outside_workspace",
  "privilege_elevation",
  "secret_access",
  "remote_script",
  "system_destroy",
  "opaque_command",
];

export interface HostCommandContext {
  /** `process.platform` of the machine the command runs on. */
  platform: string;
  /** The bot's own working directory. Without one, only relative paths count as inside. */
  workspace?: string;
  home: string;
  /** Where the command starts. Defaults to the workspace. */
  cwd?: string;
  /** The system temporary directory: deleting strictly below it is not flagged. */
  tempDir?: string;
  /** Folders holding the app's own secrets. Touching them outside the workspace is flagged. */
  protectedRoots?: string[];
}

const MAX_COMMAND_LENGTH = 50_000;
const MAX_DEPTH = 4;
const GLOB = /[*?[{]/;

/** Reason sentences for the approval card. */
export const HOST_COMMAND_RISK_TEXT: Record<HostCommandRisk, string> = {
  delete_outside_workspace: "Deletes files or folders outside this bot's workspace.",
  privilege_elevation: "Asks for administrator or root rights.",
  secret_access: "Touches keys, passwords, tokens or other credentials.",
  remote_script: "Downloads a script and runs it.",
  system_destroy: "Can damage disks, partitions or the system.",
  opaque_command: "Hides what it runs, so it cannot be checked.",
};

export function classifyHostCommand(
  command: string,
  context: HostCommandContext,
): HostCommandRisk[] {
  const found = new Set<HostCommandRisk>();
  const env = createEnvironment(context);
  if (command.length > MAX_COMMAND_LENGTH) found.add("opaque_command");
  scan(command.slice(0, MAX_COMMAND_LENGTH), env, 0, found, env.cwd);
  return HOST_COMMAND_RISKS.filter((risk) => found.has(risk));
}

// ---------------------------------------------------------------------------------------------
// Paths

interface Environment {
  win: boolean;
  home: string;
  workspace: string;
  tempDir: string | undefined;
  protectedRoots: string[];
  cwd: string;
  variables: Record<string, string | undefined>;
}

function createEnvironment(context: HostCommandContext): Environment {
  const win = context.platform === "win32";
  const home = normalizePath(context.home, win) ?? "/";
  const workspace =
    (context.workspace ? normalizePath(context.workspace, win) : undefined) ??
    (win ? "z:/vnbot-workspace" : "/vnbot-workspace");
  const tempDir = context.tempDir ? normalizePath(context.tempDir, win) : undefined;
  const cwd = (context.cwd ? resolvePath(workspace, context.cwd, win) : undefined) ?? workspace;
  const appData = win ? `${home}/appdata/roaming` : undefined;
  const localAppData = win ? `${home}/appdata/local` : undefined;
  return {
    win,
    home,
    workspace,
    tempDir,
    protectedRoots: (context.protectedRoots ?? [])
      .map((root) => normalizePath(root, win))
      .filter((root): root is string => root !== undefined),
    cwd,
    variables: {
      HOME: home,
      USERPROFILE: home,
      HOMEPATH: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
    },
  };
}

/** Forward slashes, no `.` or `..`, no trailing slash, lower case on Windows. Undefined for a relative path. */
function normalizePath(value: string, win: boolean): string | undefined {
  let text = win ? value.replace(/\\/g, "/") : value;
  if (win) text = text.toLowerCase();
  let prefix = "";
  if (win && /^[a-z]:(\/|$)/.test(text)) {
    prefix = text.slice(0, 2);
    text = text.slice(2) || "/";
  } else if (win && text.startsWith("//")) {
    prefix = "//";
    text = text.slice(2);
    return `${prefix}${collapse(text.split("/"))}`;
  } else if (!text.startsWith("/")) return undefined;
  return `${prefix}/${collapse(text.split("/"))}`.replace(/\/$/, "") || `${prefix}/`;
}

function collapse(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function resolvePath(base: string, value: string, win: boolean): string | undefined {
  const absolute = normalizePath(value, win);
  if (absolute) return absolute;
  // A drive-relative path such as `c:foo` or a rooted path without a drive depends on state we lack.
  if (win && (/^[a-z]:/i.test(value) || /^[\\/]/.test(value))) return undefined;
  const joined = `${base}/${win ? value.replace(/\\/g, "/") : value}`;
  return normalizePath(win ? joined : joined, win);
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function isStrictlyWithin(child: string, root: string): boolean {
  return child !== root && isWithin(child, root);
}

type Resolved = { kind: "path"; path: string } | { kind: "unknown" };

/** Expands `~`, `$HOME`, `%USERPROFILE%` and friends; anything left unexpanded is unknown. */
function expand(value: string, env: Environment): string | undefined {
  // A PowerShell expression such as `(Join-Path …)` is not a path we can read.
  if (/[()]/.test(value)) return undefined;
  let text = value;
  if (/^~(?=$|[\\/])/.test(text)) text = env.home + text.slice(1);
  const lookup = (name: string): string | undefined => {
    const key = name.toUpperCase();
    return key === "PWD" ? env.cwd : env.variables[key];
  };
  let unresolved = false;
  const replace = (_match: string, name: string) => {
    const resolved = lookup(name);
    if (resolved === undefined) unresolved = true;
    return resolved ?? "";
  };
  text = text
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, replace)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, replace)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, replace)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, replace);
  if (unresolved || /[$`]/.test(text)) return undefined;
  return text;
}

/** Resolves one path argument against `cwd`. Globs resolve by their literal directory prefix. */
function resolveTarget(value: string, env: Environment, cwd: string | null): Resolved {
  const expanded = expand(value, env);
  if (expanded === undefined) return { kind: "unknown" };
  const text = env.win ? expanded.replace(/\\/g, "/") : expanded;
  const parts = text.split("/");
  const globAt = parts.findIndex((part) => GLOB.test(part));
  let literal = text;
  if (globAt >= 0) {
    if (parts.slice(globAt + 1).includes("..")) return { kind: "unknown" };
    literal = parts.slice(0, globAt).join("/");
    if (literal === "" && text.startsWith("/")) literal = "/";
    if (literal === "") literal = ".";
  }
  const absolute = normalizePath(literal, env.win);
  if (absolute !== undefined) return { kind: "path", path: absolute };
  // A relative path depends on where an earlier `cd` left the shell.
  if (cwd === null) return { kind: "unknown" };
  const path = resolvePath(cwd, literal, env.win);
  return path === undefined ? { kind: "unknown" } : { kind: "path", path };
}

// ---------------------------------------------------------------------------------------------
// Tokens

interface Segment {
  tokens: string[];
  raw: string;
  /** Output of this segment feeds the next one. */
  piped: boolean;
}

/** Splits at unquoted `; & | newline ( )`; removes quotes and escapes from tokens. */
function splitSegments(command: string, win: boolean): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let token = "";
  let hasToken = false;
  let raw = "";
  let quote: "'" | '"' | null = null;
  const endToken = () => {
    if (hasToken) tokens.push(token);
    token = "";
    hasToken = false;
  };
  const endSegment = (piped: boolean) => {
    endToken();
    if (tokens.length > 0 || piped) segments.push({ tokens, raw: raw.trim(), piped });
    tokens = [];
    raw = "";
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote === "'") {
      raw += char;
      if (char === "'") quote = null;
      else token += char;
      continue;
    }
    if (quote === '"') {
      raw += char;
      if (char === '"') quote = null;
      else if (char === "\\" && !win && next && /["\\$`\n]/.test(next)) {
        token += next;
        raw += next;
        i++;
      } else if (char === "`" && win && next) {
        token += next;
        raw += next;
        i++;
      } else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      raw += char;
      continue;
    }
    if (char === "\\" && !win && next !== undefined) {
      if (next !== "\n") {
        token += next;
        hasToken = true;
      }
      raw += char + next;
      i++;
      continue;
    }
    if (char === "`" && win && next !== undefined) {
      token += next;
      hasToken = true;
      raw += char + next;
      i++;
      continue;
    }
    if (char === ";" || char === "\n" || char === "\r") {
      endSegment(false);
      continue;
    }
    if (char === "&") {
      // `&&`, `&` (background, or PowerShell's call operator), and `2>&1` style redirects.
      const previous = command[i - 1];
      if (previous === ">" || previous === "<" || next === ">") {
        token += char;
        hasToken = true;
        raw += char;
        continue;
      }
      endSegment(false);
      if (next === "&") i++;
      continue;
    }
    if (char === "|") {
      const piped = next !== "|";
      endSegment(piped);
      if (next === "|" || next === "&") i++;
      continue;
    }
    // PowerShell parentheses group an expression (`iex (iwr …)`), so they stay in the segment there.
    if (
      !win &&
      (char === "(" || char === ")") &&
      !(char === "(" && /[$<>]/.test(command[i - 1] ?? ""))
    ) {
      endSegment(false);
      continue;
    }
    if (/\s/.test(char)) {
      raw += char;
      endToken();
      continue;
    }
    token += char;
    hasToken = true;
    raw += char;
  }
  endSegment(false);
  return segments;
}

/** The inner text of `$( )`, `<( )`, `>( )` and backtick substitutions. */
function substitutions(command: string): string[] {
  const inner: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if ((char === "$" || char === "<" || char === ">") && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
        j++;
      }
      inner.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
    } else if (char === "`") {
      const end = command.indexOf("`", i + 1);
      if (end > i) {
        inner.push(command.slice(i + 1, end));
        i = end;
      }
    }
  }
  return inner;
}

const WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nohup",
  "time",
  "nice",
  "ionice",
  "setsid",
  "stdbuf",
  "timeout",
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "{",
  "}",
  "call",
  "start",
  "&",
  ".\\",
]);

function baseName(token: string): string {
  const name = token.replace(/\\/g, "/").split("/").pop() ?? token;
  return name.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

function commandIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const name = baseName(token);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || WRAPPERS.has(name)) index++;
    else if (ELEVATION.has(name)) {
      // `sudo -E bash`: the options belong to the elevation word.
      index++;
      while (tokens[index]?.startsWith("-")) index++;
    } else break;
  }
  return index;
}

// ---------------------------------------------------------------------------------------------
// Detection

const ELEVATION = new Set([
  "sudo",
  "sudoedit",
  "doas",
  "pkexec",
  "run0",
  "gsudo",
  "runas",
  "psexec",
  "psexec64",
  "visudo",
]);
const DELETE = new Set([
  "rm",
  "unlink",
  "shred",
  "srm",
  "del",
  "erase",
  "rd",
  "rmdir",
  "remove-item",
  "ri",
  "rimraf",
]);
const DOWNLOADERS = new Set([
  "curl",
  "wget",
  "fetch",
  "aria2c",
  "iwr",
  "irm",
  "invoke-webrequest",
  "invoke-restmethod",
  "start-bitstransfer",
]);
const DOWNLOAD_TEXT =
  /\b(curl|wget|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|downloaddata|start-bitstransfer)\b/i;
const DECODE_TEXT =
  /\b(base64\s+(-d|--decode|-D)|frombase64string|xxd\s+-r|certutil\s+.*-decode|openssl\s+(enc|base64))\b/i;
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "ash",
  "csh",
  "tcsh",
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
  "php",
  "lua",
  "deno",
  "bun",
  "powershell",
  "pwsh",
  "iex",
  "invoke-expression",
  "cmd",
  "source",
  "eval",
  ".",
]);
const SHELLS_WITH_COMMAND_FLAG = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "ash",
  "powershell",
  "pwsh",
  "cmd",
]);
const DISK_TOOLS = new Set([
  "wipefs",
  "fdisk",
  "sfdisk",
  "cfdisk",
  "gdisk",
  "sgdisk",
  "parted",
  "diskpart",
  "format-volume",
  "clear-disk",
  "remove-partition",
  "initialize-disk",
  "bcdedit",
]);
const BLOCK_DEVICE = /^\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk|loop|mapper\/|dm-)/i;
const LAUNCHERS = new Set(["start-process", "saps", "invoke-item", "ii", "open", "xdg-open"]);
const COMMAND_FLAG = /^(-[a-z]*c[a-z]*|\/[ck]|-command)$/i;
const POWERSHELL_VALUE_PARAMS = new Set([
  "-include",
  "-exclude",
  "-filter",
  "-erroraction",
  "-ea",
  "-stream",
  "-credential",
  "-informationaction",
  "-warningaction",
  "-errorvariable",
  "-outvariable",
]);
const ARCHIVERS = new Set([
  "tar",
  "zip",
  "7z",
  "7za",
  "rsync",
  "scp",
  "cp",
  "compress-archive",
  "robocopy",
  "xcopy",
  "copy-item",
]);

function scan(
  command: string,
  env: Environment,
  depth: number,
  found: Set<HostCommandRisk>,
  startCwd: string | null,
): void {
  if (depth > MAX_DEPTH) {
    found.add("opaque_command");
    return;
  }
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/.test(command)) found.add("system_destroy");
  for (const inner of substitutions(command)) scan(inner, env, depth + 1, found, startCwd);

  const segments = splitSegments(command, env.win);
  let cwd: string | null = startCwd;
  const downloaded = new Set<string>();
  let pipeline: Segment[] = [];

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const { tokens } = segment;
    const first = commandIndex(tokens);
    const commandWord = tokens[first] !== undefined ? baseName(tokens[first]!) : "";

    // A pipeline runs together: an earlier stage that fetches or decodes feeds a later interpreter.
    pipeline = index > 0 && segments[index - 1]!.piped ? [...pipeline, segment] : [segment];
    if (
      pipeline.length > 1 &&
      INTERPRETERS.has(commandWord) &&
      pipeline
        .slice(0, -1)
        .some((stage) => DOWNLOAD_TEXT.test(stage.raw) || DECODE_TEXT.test(stage.raw))
    ) {
      found.add("remote_script");
    }

    // Elevation.
    tokens.forEach((token, at) => {
      const name = baseName(token);
      if (ELEVATION.has(name)) found.add("privilege_elevation");
      if (name === "su" && at === first) found.add("privilege_elevation");
    });
    if (
      /-verb\s*[:=]?\s*['"]?runas/i.test(segment.raw) ||
      /\bnet1?\s+localgroup\s+administrators/i.test(segment.raw) ||
      /\bnet1?\s+user\b.*\s\/add\b/i.test(segment.raw) ||
      /\bschtasks\b.*\/ru\s+['"]?system/i.test(segment.raw) ||
      /\badd-localgroupmember\b.*administrators/i.test(segment.raw) ||
      /\bchmod\s+(-\S+\s+)*[ugoa]*\+[rwxXt]*s/i.test(segment.raw)
    ) {
      found.add("privilege_elevation");
    }

    // Remote script: fetch-and-evaluate in one segment, or run what an earlier segment downloaded.
    // A shell given a command string is analysed as that string below.
    const runsString =
      SHELLS_WITH_COMMAND_FLAG.has(commandWord) &&
      tokens.slice(first + 1).some((t) => COMMAND_FLAG.test(t));
    if (
      INTERPRETERS.has(commandWord) &&
      !runsString &&
      (DOWNLOAD_TEXT.test(segment.raw) || DECODE_TEXT.test(segment.raw)) &&
      (commandWord !== "node" || /\s-e\b|--eval/.test(segment.raw))
    ) {
      found.add("remote_script");
    }
    if (DOWNLOADERS.has(commandWord) || tokens.some((t) => DOWNLOADERS.has(baseName(t)))) {
      for (const name of downloadTargets(tokens)) downloaded.add(name);
    }
    if (downloaded.size > 0) {
      const runs = tokens
        .slice(first)
        .filter((token) => !token.startsWith("-"))
        .map((token) => baseName(token));
      if (
        downloaded.has(commandWord) ||
        ((INTERPRETERS.has(commandWord) || LAUNCHERS.has(commandWord)) &&
          runs.slice(1).some((name) => downloaded.has(name)))
      )
        found.add("remote_script");
    }

    // System damage.
    for (const [at, token] of tokens.entries()) {
      const name = baseName(token);
      if (name.startsWith("mkfs") || DISK_TOOLS.has(name)) found.add("system_destroy");
      if (name === "dd" && tokens.slice(at + 1).some((t) => BLOCK_DEVICE.test(t.slice(3))))
        found.add("system_destroy");
      if (name === "format" && tokens.slice(at + 1).some((t) => /^[a-z]:\\?$/i.test(t)))
        found.add("system_destroy");
      if (BLOCK_DEVICE.test(token) || /^\\\\\.\\physicaldrive/i.test(token))
        found.add("system_destroy");
    }
    if (
      /\bvssadmin\s+delete\s+shadows/i.test(segment.raw) ||
      /\bwbadmin\s+delete/i.test(segment.raw) ||
      /\breg(\.exe)?\s+delete\s+['"]?hk(lm|cr|ey_local_machine|ey_classes_root)/i.test(
        segment.raw,
      ) ||
      /\bcipher(\.exe)?\s+\/w/i.test(segment.raw)
    ) {
      found.add("system_destroy");
    }

    // Secrets.
    if (touchesSecret(tokens, segment.raw, env, first, commandWord)) found.add("secret_access");

    // Deletes.
    if (
      deletesOutsideWorkspace(tokens, env, cwd, segments, index) ||
      inlineCodeDeletesOutside(segment.raw, env, cwd)
    ) {
      found.add("delete_outside_workspace");
    }
    if (recursivePermissionChangeOutside(tokens, env, cwd)) found.add("system_destroy");

    // Nested shells: scan what they are told to run.
    for (const [at, token] of tokens.entries()) {
      const name = baseName(token);
      if (!SHELLS_WITH_COMMAND_FLAG.has(name)) continue;
      const rest = tokens.slice(at + 1);
      const flagAt = rest.findIndex((t) => COMMAND_FLAG.test(t));
      if (flagAt >= 0) {
        const script = rest.slice(flagAt + 1).join(" ");
        if (script) {
          scan(script, env, depth + 1, found, cwd);
          // `bash -c "$(curl …)"` hands a fetched script to the shell without a pipe.
          if (
            /(\$\(|`|<\()/.test(script) &&
            (DOWNLOAD_TEXT.test(script) || DECODE_TEXT.test(script))
          )
            found.add("remote_script");
        }
      }
      const encodedAt = rest.findIndex((t) => /^-(e|ec|enc|encodedcommand)$/i.test(t));
      if (encodedAt >= 0) {
        const decoded = decodePowerShell(rest[encodedAt + 1]);
        if (decoded === undefined) found.add("opaque_command");
        else scan(decoded, env, depth + 1, found, cwd);
      }
    }
    if (commandWord === "eval" || commandWord === "iex" || commandWord === "invoke-expression") {
      const script = tokens.slice(first + 1).join(" ");
      if (script && !/[$`]/.test(script)) scan(script, env, depth + 1, found, cwd);
    }

    // `cd` changes where later relative paths point.
    if (["cd", "chdir", "pushd", "set-location", "sl"].includes(commandWord)) {
      const target = tokens.slice(first + 1).find((t) => !/^-[A-Za-z]/.test(t) && t !== "/d");
      if (target === undefined) cwd = env.home;
      else {
        const resolved =
          target === "-" ? { kind: "unknown" as const } : resolveTarget(target, env, cwd);
        cwd = resolved.kind === "path" ? resolved.path : null;
      }
    }
  }
}

function decodePowerShell(value: string | undefined): string | undefined {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
  try {
    const bytes = typeof Buffer !== "undefined" ? Buffer.from(value, "base64") : undefined;
    if (!bytes || bytes.length === 0) return undefined;
    const text = bytes.toString("utf16le");
    return /^[\t\n\r\x20-\x7e\u00a0-\uffff]+$/.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

function downloadTargets(tokens: string[]): string[] {
  const names: string[] = [];
  for (const [at, token] of tokens.entries()) {
    const lower = token.toLowerCase();
    const following = tokens[at + 1];
    if (
      (lower === "-o" ||
        lower === "--output" ||
        lower === "-outfile" ||
        lower === "-destination") &&
      following
    ) {
      names.push(baseName(following));
    }
    if ((token === ">" || token === ">>") && following) names.push(baseName(following));
    if (token === "-O" || lower === "--remote-name") {
      const url = tokens.find((t) => /^https?:\/\//i.test(t));
      if (url) names.push(baseName(url.split("?")[0]!));
    }
    if (/^https?:\/\//i.test(token) && baseName(tokens[0]!) === "wget")
      names.push(baseName(token.split("?")[0]!));
  }
  return names.filter(Boolean);
}

// -- deletes ---------------------------------------------------------------------------------

function deletesOutsideWorkspace(
  tokens: string[],
  env: Environment,
  cwd: string | null,
  segments: Segment[],
  index: number,
): boolean {
  const viaXargs = tokens.some((token) => baseName(token) === "xargs");
  for (let at = 0; at < tokens.length; at++) {
    const name = baseName(tokens[at]!);
    const rest = tokens.slice(at + 1);
    if (name === "find" && findDeletes(rest)) {
      const roots = findRoots(rest);
      if (roots.length === 0) roots.push(".");
      if (roots.some((root) => outside(root, env, cwd))) return true;
      continue;
    }
    if (
      name === "[system.io.directory]::delete" ||
      /^\[(system\.)?io\.(directory|file)\]::delete/i.test(tokens[at]!)
    ) {
      const target = rest.find((t) => !t.startsWith("-"));
      if (!target || outside(target.replace(/[(),;]/g, ""), env, cwd)) return true;
      continue;
    }
    if (!DELETE.has(name)) {
      if (name === "robocopy" && rest.some((t) => /^\/(mir|purge)$/i.test(t))) {
        const operands = rest.filter((t) => !t.startsWith("/"));
        if (operands[1] === undefined || outside(operands[1], env, cwd)) return true;
      }
      if (name === "rsync" && rest.some((t) => t.startsWith("--delete"))) {
        const operands = rest.filter((t) => !t.startsWith("-"));
        const destination = operands.at(-1);
        if (destination === undefined || outside(destination, env, cwd)) return true;
      }
      continue;
    }
    // `git rm`, `docker rm`, `npm rm`: the word after another command is its own subcommand.
    const previous = tokens[at - 1] !== undefined ? baseName(tokens[at - 1]!) : "";
    if (
      ["git", "docker", "podman", "npm", "pnpm", "yarn", "brew", "kubectl", "helm"].includes(
        previous,
      )
    )
      continue;
    // Targets arrive on stdin, so they cannot be checked.
    if (
      viaXargs ||
      (index > 0 && segments[index - 1]!.piped && rest.every((t) => t.startsWith("-")))
    )
      return true;
    const targets = deleteTargets(name, rest, env.win);
    if (targets.some((target) => outside(target, env, cwd))) return true;
  }
  return false;
}

const INLINE_DELETE =
  /(?:\bshutil\.rmtree|\bos\.(?:remove|unlink|rmdir|removedirs)|(?:\bfs|\bfs\.promises|\))\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)|\bFileUtils\.(?:rm_rf|rm_r|rm_f|remove_entry))\s*\(\s*(?:(['"])(.*?)\1)?/g;

/** `python -c "shutil.rmtree('/x')"`, `node -e "fs.rmSync(…)"`: the first string argument is the path. */
function inlineCodeDeletesOutside(raw: string, env: Environment, cwd: string | null): boolean {
  for (const match of raw.matchAll(INLINE_DELETE)) {
    const literal = match[2];
    if (literal === undefined || outside(literal, env, cwd)) return true;
  }
  return false;
}

function findDeletes(args: string[]): boolean {
  if (args.includes("-delete")) return true;
  const exec = args.findIndex((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg));
  return exec >= 0 && DELETE.has(baseName(args[exec + 1] ?? ""));
}

function findRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "(" || arg === "!") break;
    roots.push(arg);
  }
  return roots;
}

function deleteTargets(name: string, args: string[], win: boolean): string[] {
  const targets: string[] = [];
  const powershell =
    name === "remove-item" ||
    name === "ri" ||
    (win && args.some((a) => /^-(recurse|force|path|literalpath|lp|fo|r)$/i.test(a)));
  let afterDashes = false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (!afterDashes && arg === "--") {
      afterDashes = true;
      continue;
    }
    if (powershell && arg.startsWith("-") && !afterDashes) {
      const lower = arg.toLowerCase();
      const [switchName, inline] = lower.split(/:(.+)/s);
      if (switchName === "-path" || switchName === "-literalpath" || switchName === "-lp") {
        const value = inline !== undefined ? arg.slice(arg.indexOf(":") + 1) : args[++at];
        if (value) targets.push(...value.split(","));
      } else if (POWERSHELL_VALUE_PARAMS.has(switchName!) && inline === undefined) at++;
      continue;
    }
    if (win && !afterDashes && /^\/[a-z?](:.*)?$/i.test(arg)) continue;
    if (!afterDashes && arg.startsWith("-") && arg.length > 1) continue;
    targets.push(...(powershell ? arg.split(",") : [arg]));
  }
  return targets.filter((target) => target !== "");
}

function recursivePermissionChangeOutside(
  tokens: string[],
  env: Environment,
  cwd: string | null,
): boolean {
  for (let at = 0; at < tokens.length; at++) {
    const name = baseName(tokens[at]!);
    if (name !== "chmod" && name !== "chown" && name !== "chgrp") continue;
    const rest = tokens.slice(at + 1);
    if (!rest.some((t) => /^-[A-Za-z]*R[A-Za-z]*$/.test(t) || t === "--recursive")) continue;
    const operands = rest.filter((t) => !t.startsWith("-"));
    // The first operand is the mode or owner.
    if (operands.slice(1).some((target) => outside(target, env, cwd))) return true;
  }
  return false;
}

/** Outside the workspace and not strictly inside the temporary directory. */
function outside(target: string, env: Environment, cwd: string | null): boolean {
  const resolved = resolveTarget(target, env, cwd);
  if (resolved.kind === "unknown") return true;
  if (isWithin(resolved.path, env.workspace)) return false;
  if (env.tempDir && isStrictlyWithin(resolved.path, env.tempDir)) return false;
  return true;
}

// -- secrets ---------------------------------------------------------------------------------

const SECRET_PATH = [
  /(^|\/)\.(ssh|gnupg|aws|azure|kube|password-store|vault-token|terraform\.d)(\/|$)/,
  /(^|\/)\.config\/(gcloud|gh|git\/credentials|rclone|doctl|op|1password)(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.(npmrc|pypirc|netrc|_netrc|git-credentials|pgpass|my\.cnf|s3cfg|boto|terraformrc|dockercfg|yarnrc\.yml)$/,
  /(^|\/)_netrc$/,
  /(^|\/)\.local\/share\/(keyrings|gnome-keyring)(\/|$)/,
  /(^|\/)library\/(keychains|cookies)(\/|$)/,
  /(^|\/)\.mozilla\/firefox(\/|$)/,
  /(^|\/)\.config\/(google-chrome|chromium|brave-browser|microsoft-edge|bravesoftware)(\/|$)/,
  /(^|\/)appdata\/(local|roaming)\/(google\/chrome|microsoft\/edge|mozilla\/firefox|bravesoftware)(\/|$)/,
  /(^|\/)appdata\/(local|roaming)\/microsoft\/(credentials|protect|vault|crypto)(\/|$)/,
  /(^|\/)(login data|web data|local state|key[34]\.db|logins\.json|cert9\.db)$/,
  /(^|\/)cookies(\.sqlite)?$/,
  /(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults?$)[^/]*)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(?!\.pub)(\.[^/]*)?$/,
  /\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk)$/,
  /(^|\/)credentials(\.(json|ya?ml|xml|csv))?$/,
  /(^|\/)(secrets?|service-?account|client_secrets?)[^/]*\.(json|ya?ml|env|txt)$/,
  /(^|\/)(native-stack-env|node-key\.json)$/,
  /^\/etc\/(shadow|gshadow|sudoers(\.d\/.*)?|ssh\/ssh_host_.*_key|security\/opasswd)$/,
  /^\/root(\/|$)/,
  /^\/proc\/[^/]+\/environ$/,
  /(^|\/)windows\/system32\/config\/(sam|system|security)$/,
  /(^|\/)(ntuser\.dat|ntds\.dit)$/,
];
const SECRET_PATTERNS = SECRET_PATH.map((pattern) => new RegExp(pattern.source, "i"));
const SECRET_COMMAND =
  /\b(security\s+(find-(generic|internet)-password|dump-keychain|export)|cmdkey\s+\/list|vaultcmd|mimikatz|lazagne|get-storedcredential|gpg2?\s+.*--export-secret-keys|reg(\.exe)?\s+save\s+hklm\\(sam|security|system))\b/i;

function touchesSecret(
  tokens: string[],
  raw: string,
  env: Environment,
  first: number,
  commandWord: string,
): boolean {
  if (SECRET_COMMAND.test(raw)) return true;
  const bulk = ARCHIVERS.has(commandWord);
  for (const [at, token] of tokens.entries()) {
    if (at < first && !token.includes("/") && !token.includes("\\")) continue;
    // `--key=~/.ssh/id_rsa`, `@~/.ssh/id_rsa`, `of=/dev/sda`: look at the value part too.
    const values = new Set([token]);
    const equals = token.indexOf("=");
    if (equals > 0) values.add(token.slice(equals + 1));
    if (token.startsWith("@")) values.add(token.slice(1));
    if (token.startsWith("file://")) values.add(token.slice(7));
    for (const value of values) {
      const expanded = expand(value, env);
      if (expanded === undefined) continue;
      const text = (env.win ? expanded.replace(/\\/g, "/") : expanded).replace(/\/+$/, "/");
      const lowered = env.win ? text.toLowerCase() : text;
      // A dot-folder in the home directory named by a glob (`~/.s*`) could be any of them.
      if (
        new RegExp(`^${escapeRegExp(env.home)}/\\.[^/]*[*?[]`).test(lowered) ||
        SECRET_PATTERNS.some((pattern) => pattern.test(lowered))
      ) {
        return true;
      }
      if (bulk && (lowered.replace(/\/$/, "") === env.home || lowered === "/")) return true;
      const resolved = resolveTarget(value, env, env.cwd);
      if (
        resolved.kind === "path" &&
        env.protectedRoots.some(
          (root) => isWithin(resolved.path, root) && !isWithin(resolved.path, env.workspace),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
