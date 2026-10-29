import { describe, expect, it } from "vitest";
import { scanAllLiterals, scanLinguiSource, scanPo, scanRepo } from "./check-banned-brand.ts";

const terms = (findings: Array<{ term: string }>) => findings.map((f) => f.term);

describe("check-banned-brand", () => {
  it("passes on the current repo", () => {
    expect(scanRepo()).toEqual([]);
  });

  it("flags banned terms in catalog msgstr, including multi-line values", () => {
    const po = 'msgid "About"\nmsgstr ""\n"Giới thiệu Rakazo, "\n"mã nguồn mở"\n';
    expect(terms(scanPo("vi.po", po))).toEqual(["Rakazo", "mã nguồn mở"]);
  });

  it("flags <Trans>, t`` and message props but not identifiers or imports", () => {
    const src = [
      'import { x } from "@rakazo/core";',
      "const rakazoId = 1;",
      "<Trans>Open in Cursor</Trans>",
      "t`Powered by Grok`;",
      't({ message: "Rakazo open source" });',
    ].join("\n");
    expect(terms(scanLinguiSource("a.tsx", src))).toEqual([
      "Cursor",
      "Grok",
      "Rakazo",
      "open source",
    ]);
  });

  it("allows lowercase cursor as an ordinary word", () => {
    expect(scanLinguiSource("a.tsx", "<Trans>Move the cursor here</Trans>")).toEqual([]);
  });

  it("scans every literal and JSX text in prompt/email files, skipping comments and imports", () => {
    const src = [
      'import { a } from "@rakazo/adapter-kit";',
      "// Rakazo comment is fine",
      'const prompt = "You are a Rakazo bot";',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source text containing a template literal
      "const link = `see ${url} github.com/elie222/rakazo`;",
      "<Text>Welcome to Grok</Text>",
    ].join("\n");
    expect(terms(scanAllLiterals("p.ts", src))).toEqual([
      "Rakazo",
      "github.com/elie222",
      "rakazo",
      "Grok",
    ]);
  });

  it("honours a brand-allow comment on the line above", () => {
    const src = '// brand-allow: legal notice 2026-12 Maya\nconst s = "Rakazo";';
    expect(scanAllLiterals("p.ts", src)).toEqual([]);
  });
});
