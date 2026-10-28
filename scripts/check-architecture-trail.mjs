import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const JUSTIFICATION_LABEL = "no-arch-change";
export const BASELINE_LABEL = "baseline-typo";
const JUSTIFICATION_RE = /Architecture-trail-justification:\s*(\S.*)/i;

const configUrl = new URL("./architecture-trail.config.json", import.meta.url);

export function loadConfig(url = configUrl) {
  return JSON.parse(readFileSync(url, "utf8"));
}

/** `**` crosses directories. `*` stays inside one path segment. */
export function globToRegExp(glob) {
  let pattern = "^";
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith("**/", index)) {
      pattern += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (glob.startsWith("**", index)) {
      pattern += ".*";
      index += 2;
      continue;
    }
    const char = glob[index];
    index += 1;
    if (char === "*") pattern += "[^/]*";
    else if ("\\^$+?.()|[]{}".includes(char)) pattern += `\\${char}`;
    else pattern += char;
  }
  return new RegExp(`${pattern}$`);
}

export function matchesSensitive(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * @param {object} input
 * @param {Array<{ path: string, additions?: string }>} input.files
 * @param {string[]} input.labels
 * @param {string} input.body
 * @param {boolean} input.baseHasBaseline true when the base branch already contains the frozen map
 * @param {ReturnType<typeof loadConfig>} input.config
 */
export function evaluate(input) {
  const failures = [];
  const config = input.config;
  const labels = input.labels ?? [];
  const body = input.body ?? "";
  const files = input.files ?? [];
  const baselineTouched = files.filter((file) => file.path.startsWith(config.baselinePrefix));
  if (baselineTouched.length > 0 && input.baseHasBaseline && !labels.includes(BASELINE_LABEL)) {
    failures.push(
      `Frozen baseline edited (${baselineTouched.map((file) => file.path).join(", ")}). ` +
        "Leave docs/architecture/rakazo-baseline/ unchanged, or add the label " +
        `${BASELINE_LABEL} for a typo.`,
    );
  }

  const sensitive = files.filter(
    (file) => file.path !== config.changelog && matchesSensitive(file.path, config.sensitive),
  );
  if (sensitive.length === 0) return failures;

  const changelog = files.find((file) => file.path === config.changelog);
  const additions = changelog?.additions ?? "";
  const entryOk =
    changelog &&
    /\d{4}-\d{2}-\d{2}/.test(additions) &&
    /what changed/i.test(additions) &&
    /\bwhy\b/i.test(additions) &&
    /file|module/i.test(additions) &&
    /invariant/i.test(additions) &&
    /\badr\b|docs\/architecture\/vnbot\/adr\//i.test(additions) &&
    /\bpull request\b|\bPR\b|github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(additions);

  if (entryOk) return failures;
  if (labels.includes(JUSTIFICATION_LABEL)) {
    const justification = body.match(JUSTIFICATION_RE)?.[1]?.trim() ?? "";
    if (justification.length >= 20) return failures;
    failures.push(
      `Label ${JUSTIFICATION_LABEL} needs a pull request line ` +
        '"Architecture-trail-justification:" followed by at least 20 characters ' +
        "explaining why this is not an architecture change.",
    );
    return failures;
  }

  const names = sensitive.map((file) => file.path).join(", ");
  failures.push(
    `Architecture-sensitive paths changed without a changelog entry: ${names}. ` +
      `Add an entry to ${config.changelog} (date, pull request, what changed versus ` +
      "the baseline, why, modules and files, invariants affected, ADR link), or add the label " +
      `${JUSTIFICATION_LABEL} with Architecture-trail-justification: in the description.`,
  );
  return failures;
}

export function parseNameStatus(text) {
  const files = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [status, first, second] = line.split("\t");
    const code = status[0];
    if (code === "R" || code === "C") files.push({ path: second });
    else files.push({ path: first });
  }
  return files;
}

export function addedLines(diff) {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

function git(args, cwd, quiet = false) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  });
}

export function changesFromGit(base, head, cwd, config) {
  const nameStatus = git(["diff", "--name-status", base, head], cwd);
  const files = parseNameStatus(nameStatus);
  let baseHasBaseline = true;
  try {
    git(["cat-file", "-e", `${base}:${config.baselineMarker}`], cwd, true);
  } catch {
    baseHasBaseline = false;
  }
  const changelog = files.find((file) => file.path === config.changelog);
  if (changelog) {
    const diff = git(["diff", "--unified=0", base, head, "--", config.changelog], cwd);
    changelog.additions = addedLines(diff);
  }
  return { files, baseHasBaseline };
}

function labelsFromEnv(value) {
  if (!value?.trim()) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return parsed.filter((label) => typeof label === "string");
  }
  return trimmed
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function main() {
  const cwd = process.cwd();
  const config = loadConfig();
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA ?? "HEAD";
  if (!base) {
    console.error("BASE_SHA is required (the pull request base commit).");
    process.exit(2);
  }
  const { files, baseHasBaseline } = changesFromGit(base, head, cwd, config);
  const failures = evaluate({
    files,
    labels: labelsFromEnv(process.env.PR_LABELS),
    body: process.env.PR_BODY ?? "",
    baseHasBaseline,
    config,
  });
  if (failures.length === 0) {
    console.log("Architecture trail check passed.");
    return;
  }
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
