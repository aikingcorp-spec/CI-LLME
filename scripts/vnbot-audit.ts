import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translationsOf } from "../.agents/skills/translate/catalog-gaps.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OLD = path.resolve(ROOT, "../VNBot-0310-V2");
const containsOldBrand = (text: string) => /rakazo/i.test(text.replace(/\brakazo-shared\b/g, ""));
const REMOVED_BY_S00 = new Map([
  ["apps/web/src/pages/Pairing.tsx", "S00 removes P2P pairing."],
  ["apps/web/src/components/ApprovalRulePreview.tsx", "S00 removes approval rule preview."],
  ["apps/web/src/components/TaskContinuitySettings.tsx", "S00 removes Task Continuity."],
  ["apps/web/src/components/WebhookDelegations.tsx", "S00 removes Webhook Delegation."],
]);

export function catalogBrandLeaks(po: string): string[] {
  // The source text is the displayed fallback for an untranslated entry.
  const translated = translationsOf(po);
  return po.split(/\r?\n\r?\n/).flatMap((block) => {
    if (/^#~/m.test(block)) return [];
    const field = /^msgid (".*"(?:\r?\n".*")*)/m.exec(block);
    if (!field) return [];
    const id = field[1]!
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .join("");
    if (!id) return [];
    const context = /^msgctxt (".*")/m.exec(block);
    const key = `${block.includes("#. js-lingui-explicit-id") ? "explicit-id:" : ""}${context ? `${JSON.parse(context[1]!)}\u0004` : ""}${id}`;
    return containsOldBrand(translated[key] ?? id) ? [key] : [];
  });
}

export function htmlBrandLeaks(html: string): string[] {
  const content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const labels = [
    ...content.matchAll(/\b(?:title|alt|aria-label|placeholder)\s*=\s*(["'])(.*?)\1/gi),
  ].map((match) => match[2]!);
  const text = content.replace(/<[^>]*>/g, " ");
  return [...labels, text].filter(containsOldBrand);
}

async function files(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const key = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing linked audit input: ${key}`);
    if (entry.isDirectory()) result.push(...(await files(root, key)));
    else if (entry.isFile()) result.push(key);
  }
  return result.sort();
}

export async function screenInventory(old: string, current: string) {
  const roots = ["apps/web/src/pages", "apps/web/src/components", "apps/desktop/src"];
  const rows: Array<{ file: string; state: "identical-source" | "changed-source" | "missing" }> =
    [];
  for (const root of roots) {
    const all = await files(path.join(old, root));
    for (const file of all) {
      if (file.includes(".test.") || file.includes(".spec.")) continue;
      if (root.endsWith("desktop/src") ? !/\.(html|css)$/.test(file) : !file.endsWith(".tsx"))
        continue;
      const key = path.join(root, file);
      const source = await readFile(path.join(old, key));
      let target: Buffer;
      try {
        target = await readFile(path.join(current, key));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        const reason = REMOVED_BY_S00.get(key.split(path.sep).join("/"));
        rows.push(
          reason ? { file: key, state: "removed-by-S00", reason } : { file: key, state: "missing" },
        );
        continue;
      }
      const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
      rows.push({
        file: key,
        state: hash(source) === hash(target) ? "identical-source" : "changed-source",
      });
    }
  }
  return rows;
}

export async function main(args: string[]) {
  if (args[0] === "screens" && args.length === 1) {
    const rows = await screenInventory(OLD, ROOT);
    console.log(
      JSON.stringify(
        {
          scope:
            "Source inventory only. Changed and missing files need review against the shipped 0.3.9 screen. Identical source is not visual proof.",
          rows,
        },
        null,
        2,
      ),
    );
    return rows.some((row) => row.state === "changed-source" || row.state === "missing") ? 1 : 0;
  }
  if (args[0] === "brand" && args.length >= 1) {
    const findings: Array<{ file: string; field: string }> = [];
    for (const locale of ["vi", "en"]) {
      const file = `packages/i18n/locales/${locale}/messages.po`;
      for (const key of catalogBrandLeaks(await readFile(path.join(ROOT, file), "utf8")))
        findings.push({ file, field: key });
    }
    let built = 0;
    for (const directory of ["apps/web/dist", "apps/desktop/dist"]) {
      for (const file of await files(path.join(ROOT, directory))) {
        if (!file.endsWith(".html")) continue;
        built++;
        for (const _leak of htmlBrandLeaks(
          await readFile(path.join(ROOT, directory, file), "utf8"),
        ))
          findings.push({ file: path.join(directory, file), field: "built HTML text or label" });
      }
    }
    // Optional inputs are rendered DOM captures and actual bot pwd/ls output, never JS bundles.
    for (const file of args.slice(1)) {
      if (!(await stat(file)).isFile())
        throw new Error("Expected a rendered HTML or bot path text file.");
      const content = await readFile(file, "utf8");
      const leaks = file.endsWith(".html")
        ? htmlBrandLeaks(content)
        : containsOldBrand(content)
          ? [content]
          : [];
      if (leaks.length) findings.push({ file, field: "rendered UI or bot output" });
    }
    console.log(
      JSON.stringify(
        {
          builtHtmlFiles: built,
          findings,
          limitation:
            "Static catalogs and built HTML only unless rendered DOM and bot output files are supplied. This does not certify lazy dialogs, emails or runtime errors.",
        },
        null,
        2,
      ),
    );
    return findings.length ? 1 : 0;
  }
  console.error(
    "Usage: pnpm exec tsx scripts/vnbot-audit.ts screens | brand [rendered.html bot-paths.txt ...]",
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("Audit input is missing or unreadable; no pass was recorded.");
      process.exitCode = 2;
    });
}
