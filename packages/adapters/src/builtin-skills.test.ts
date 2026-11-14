import { readdirSync, readFileSync } from "node:fs";
import { parseSkillMd } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { RAKAZO_DOCS_URLS } from "./builtin-skills.js";
import { VNBOT_HELP_INDEX_URL, VNBOT_PLATFORM_IDENTITY } from "./platform-identity.js";
import { builtinAgentSkillRecords } from "./skill-tools.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const readRepo = (path: string) => readFileSync(repoFile(path), "utf8");
const httpsUrls = (text: string) =>
  [...text.matchAll(/https:\/\/[^\s)]+/g)].map((match) => match[0].replace(/[.,;:]+$/, ""));

describe("VNBot guide contract", () => {
  it("trusts only the exact guide index", () => {
    expect(RAKAZO_DOCS_URLS).toEqual([VNBOT_HELP_INDEX_URL]);
    expect(VNBOT_HELP_INDEX_URL).toBe("https://vnbot.run/help.md");
    expect(RAKAZO_DOCS_URLS).not.toContain("https://vnbot.run/help/mo-hinh.md");
    expect(RAKAZO_DOCS_URLS).not.toContain("https://vnbot.run/help.md?x=1");
    expect(readRepo("apps/www/src/vnbot-help.ts")).toContain(VNBOT_HELP_INDEX_URL);
  });

  it("keeps the published chapter files in the help nav and out of the skill", () => {
    const slugs = [...readRepo("apps/www/src/vnbot-help.ts").matchAll(/slug: "([a-z0-9-]+)"/g)].map(
      (match) => match[1],
    );
    const files = readdirSync(repoFile("docs/vnbot"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
    expect([...slugs].sort()).toEqual(files);
    expect(new Set(slugs).size).toBe(slugs.length);
    const guide = builtinAgentSkillRecords().find((item) => item.name === "VNBot");
    if (!guide) throw new Error("missing VNBot skill");
    for (const slug of slugs) {
      expect(guide.content).not.toContain(slug);
      expect(readRepo(`docs/vnbot/${slug}.md`).toLowerCase()).not.toContain("rakazo");
    }
  });

  it("routes with one index URL and leaves install steps out of the skill", () => {
    const guide = builtinAgentSkillRecords().find((item) => item.name === "VNBot");
    if (!guide) throw new Error("missing VNBot skill");
    const parsed = parseSkillMd(guide.content);
    if (!parsed || "error" in parsed)
      throw new Error(parsed && "error" in parsed ? parsed.error : "unparsed");
    expect(httpsUrls(parsed.body)).toEqual([VNBOT_HELP_INDEX_URL]);
    expect(parsed.body.length).toBeLessThan(1200);
    expect(parsed.body).toContain("web_fetch");
    expect(parsed.body).toContain("guide is unavailable");
    expect(parsed.body).not.toContain("dl.vnbot.run");
    expect(parsed.body).not.toContain("Sắp ra mắt");
    expect(parsed.body).not.toContain("whitelist");
    expect(parsed.body).not.toContain("ghép mã");
    expect(parsed.body).not.toContain("Task Continuity");
  });
});

describe("bundled VNBot guide", () => {
  it("publishes one product guide through the existing read-only catalog", () => {
    const records = builtinAgentSkillRecords();
    expect(records.map((item) => item.name)).toEqual(["Interrogate", "VNBot"]);
    const guide = records.find((item) => item.name === "VNBot");
    if (!guide) throw new Error("missing VNBot skill");
    expect(guide).toMatchObject({ id: "builtin:VNBot", source: "builtin", readOnly: true });
    const parsed = parseSkillMd(guide.content);
    if (!parsed || "error" in parsed)
      throw new Error(parsed && "error" in parsed ? parsed.error : "unparsed");
    expect(parsed.name).toBe(guide.name);
    expect(parsed.description).toBe(guide.description);
    expect(parsed.body.length).toBeGreaterThan(0);
    expect(guide.description.length).toBeLessThanOrEqual(72);
  });
});

describe("platform identity", () => {
  it("names the official site and app, and no private copy", () => {
    expect(httpsUrls(VNBOT_PLATFORM_IDENTITY)).toEqual([
      "https://vnbot.run",
      "https://app.vnbot.run",
    ]);
    expect(VNBOT_PLATFORM_IDENTITY.length).toBeLessThan(800);
    expect(VNBOT_PLATFORM_IDENTITY).toContain("already in this chat");
    expect(VNBOT_PLATFORM_IDENTITY).toContain("not the official website");
    expect(VNBOT_PLATFORM_IDENTITY).not.toContain("dl.vnbot.run");
    expect(VNBOT_PLATFORM_IDENTITY).not.toContain("/home/");
    expect(VNBOT_PLATFORM_IDENTITY).not.toContain("@");
  });
});
