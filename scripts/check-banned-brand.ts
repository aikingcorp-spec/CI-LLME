// Guard (pnpm lint): fail when a banned brand term appears in a user-facing string.
// Term list: packages/core/src/banned-brand.ts (single source of truth).
// Scans: msgstr of every web catalog; <Trans>, t``/msg`` literals in apps/web/src and
// apps/mobile/src; every string literal in the email template and the bot prompt.
// URLs: every http(s)/ghcr/github URL in any string literal of non-test source in apps/, packages/
// and infra/, since a URL is shown to users or sent to third parties (User-Agent, store links).
// Identifiers and import specifiers keep the Rakazo name (AGENTS.md) and are not scanned.
// Exception: put `// brand-allow: <reason> <expiry> <approver>` on the line or the line above.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findBannedBrandTerms } from "../packages/core/src/banned-brand.ts";

export type Finding = { file: string; line: number; term: string; text: string };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOW = /brand-allow:/;

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

function allowed(lines: string[], line: number) {
  return ALLOW.test(lines[line - 1] ?? "") || ALLOW.test(lines[line - 2] ?? "");
}

function collect(
  file: string,
  source: string,
  spans: Array<[number, string]>,
  url = false,
): Finding[] {
  const lines = source.split("\n");
  return spans.flatMap(([index, text]) => {
    const line = lineOf(source, index);
    if (allowed(lines, line)) return [];
    return findBannedBrandTerms(text, {
      modelProviderList: file === "packages/adapters/src/pi-models.ts",
      url,
    }).map((term) => ({ file, line, term, text: text.trim() }));
  });
}

/** msgstr values of a .po catalog (multi-line strings joined). */
export function scanPo(file: string, source: string): Finding[] {
  const spans: Array<[number, string]> = [];
  for (const m of source.matchAll(/^msgstr(?:\[\d+\])? ((?:"(?:[^"\\]|\\.)*"\s*)+)/gmu)) {
    const text = [...(m[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((s) => s[1]).join("");
    spans.push([m.index ?? 0, text]);
  }
  return collect(file, source, spans);
}

/** Lingui source strings: <Trans>…</Trans>, t`…`, msg`…`, and message/comment props of t({}). */
export function scanLinguiSource(file: string, source: string): Finding[] {
  const spans: Array<[number, string]> = [];
  for (const m of source.matchAll(/<Trans\b[^>]*>([\s\S]*?)<\/Trans>/gu))
    spans.push([m.index ?? 0, m[1] ?? ""]);
  for (const m of source.matchAll(/\b(?:t|msg)`((?:[^`\\]|\\.)*)`/gu))
    spans.push([m.index ?? 0, m[1] ?? ""]);
  for (const m of source.matchAll(/\bmessage:\s*(["'`])((?:(?!\1)[^\\]|\\.)*)\1/gu))
    spans.push([m.index ?? 0, m[2] ?? ""]);
  return collect(file, source, spans);
}

/** String literals and template chunks, skipping comments; template `${}` holes are skipped. */
export function stringLiterals(source: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
    } else if (c === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2);
      if (i < 0) break;
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const start = i;
      let text = "";
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") {
          text += source.slice(i, i + 2);
          i += 2;
        } else if (c === "`" && source[i] === "$" && source[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < source.length && depth > 0) {
            if (source[i] === "{") depth++;
            else if (source[i] === "}") depth--;
            i++;
          }
          text += " ";
        } else if (c !== "`" && source[i] === "\n") {
          break;
        } else {
          text += source[i];
          i++;
        }
      }
      out.push([start, text]);
      i++;
    } else {
      i++;
    }
  }
  return out;
}

/** Every string literal and JSX text, except import/export specifiers. */
export function scanAllLiterals(file: string, source: string): Finding[] {
  const spans = stringLiterals(source).filter(([index]) => {
    const before = source.slice(Math.max(0, index - 40), index);
    return !/\b(?:from|import)\s*\(?\s*$/u.test(before);
  });
  for (const m of source.matchAll(/>([^<>{}]*\p{L}[^<>{}]*)</gu))
    spans.push([m.index ?? 0, m[1] ?? ""]);
  return collect(file, source, spans);
}

const URL_TOKEN =
  /(?:https?:\/\/|ghcr\.io\/|(?:github\.com|githubusercontent\.com)[/:])[^\s"'`()<>{}]*/giu;

/** URLs inside string literals (any case). Comments are skipped; brand-allow applies. */
export function scanUrls(file: string, source: string): Finding[] {
  const spans: Array<[number, string]> = [];
  for (const [index, text] of stringLiterals(source))
    for (const m of text.matchAll(URL_TOKEN)) spans.push([index, m[0]]);
  return collect(file, source, spans, true);
}

function walk(dir: string, accept: (path: string) => boolean): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    if (["node_modules", "dist", "generated", "__fixtures__", ".astro", ".expo"].includes(name))
      return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, accept);
    return accept(path) ? [path] : [];
  });
}

export function scanRepo(root = ROOT): Finding[] {
  const read = (path: string) => readFileSync(path, "utf8");
  const rel = (path: string) => relative(root, path);
  const isSource = (p: string) =>
    /\.(?:tsx?|jsx?)$/u.test(p) && !/\.(?:test|spec)\.[jt]sx?$/u.test(p);
  return [
    ...walk(join(root, "apps/web/src/locales"), (p) => p.endsWith(".po")).flatMap((p) =>
      scanPo(rel(p), read(p)),
    ),
    // Mobile has no src/: its screens live in app/, components/ and lib/.
    ...["apps/web/src", "apps/mobile/app", "apps/mobile/components", "apps/mobile/lib"]
      .flatMap((d) => walk(join(root, d), isSource))
      .flatMap((p) => scanLinguiSource(rel(p), read(p))),
    ...["apps", "packages", "infra"]
      .flatMap((d) =>
        walk(join(root, d), (p) => (isSource(p) || p.endsWith(".astro")) && !p.includes("/e2e/")),
      )
      .filter((p) => !p.endsWith("packages/core/src/banned-brand.ts"))
      .flatMap((p) => scanUrls(rel(p), read(p))),
    ...[
      "apps/api/src/catalog-descriptions-vi.ts",
      "packages/auth/src/email.tsx",
      "packages/adapters/src/pi-runtime.ts",
    ].flatMap((p) => scanAllLiterals(p, read(join(root, p)))),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = scanRepo();
  if (findings.length === 0) {
    console.log("banned-brand: OK");
  } else {
    for (const f of findings) {
      console.error(
        `banned-brand: "${f.term}" trong chuỗi người đọc tại ${f.file}:${f.line}: ${JSON.stringify(f.text.slice(0, 100))}`,
      );
    }
    console.error(
      `banned-brand: ${findings.length} chỗ. Dùng tên VNBot (packages/core/src/banned-brand.ts là danh sách từ cấm) hoặc ghi ngoại lệ // brand-allow: <lý do> <hạn> <người duyệt>.`,
    );
    process.exit(1);
  }
}
