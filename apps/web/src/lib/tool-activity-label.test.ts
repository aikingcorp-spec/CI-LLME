import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { humanizeToolName } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinToolNames } from "./builtin-tool-labels";
import {
  askCardText,
  builtinToolOfStepLabel,
  isToolActivityLine,
  toolActivityLine,
  toolStepLabel,
} from "./tool-activity-label";

beforeAll(async () => {
  const filename = fileURLToPath(new URL("../locales/vi/messages.po", import.meta.url));
  const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
    locale: "vi",
    sourceLocale: "en",
    filename,
  });
  i18n.load(
    "vi",
    Object.fromEntries(
      Object.entries(catalog).map(([id, entry]) => [
        entry.message || id,
        entry.translation || entry.message || id,
      ]),
    ),
  );
  i18n.activate("vi");
});
afterAll(() => i18n.activate("en"));

// Tests run the Lingui macro as plain English, so the Vietnamese forms are read from the catalog.
const vi = (id: string, values: Record<string, string>) => i18n._({ id, values });

describe("tool status lines", () => {
  it("has Vietnamese forms that keep the detail", () => {
    expect(vi("Searching the web: {detail}", { detail: "giá vàng SJC" })).toBe(
      "Đang tìm trên web: giá vàng SJC",
    );
    expect(vi("Using {server}: {tool}", { server: "github", tool: "create_issue" })).toBe(
      "Đang dùng github: create_issue",
    );
    expect(vi("Using the page", {})).toBe("Đang thao tác trên trang");
  });

  it("shows text it does not know as written", () => {
    expect(isToolActivityLine("Chào bạn")).toBe(false);
    expect(toolActivityLine("Chào bạn")).toBe("Chào bạn");
  });

  // Every line the server can write must have a translated form, so a new line in
  // describeToolActivity cannot ship in English.
  it("covers every line describeToolActivity can return", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL("../../../../packages/adapters/src/pi-runtime-tools.ts", import.meta.url),
      ),
      "utf8",
    );
    const body = source.slice(source.indexOf("export function describeToolActivity"));
    const returned = [
      ...body.slice(0, body.indexOf("\n}\n")).matchAll(/return\s+(?:`([^`]*)`|"([^"]*)")/gu),
    ].map((match) => (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/gu, "x"));
    expect(returned.length).toBeGreaterThan(30);
    for (const line of returned) expect(isToolActivityLine(line), line).toBe(true);
  });
});

describe("tool step labels", () => {
  it("finds the built-in tool behind every recorded label", () => {
    for (const name of builtinToolNames())
      expect(builtinToolOfStepLabel(humanizeToolName(name)), name).toBe(name);
  });

  it("keeps a connector tool label as recorded", () => {
    expect(toolStepLabel("Create issue")).toBe("Create issue");
  });

  // A call whose detail is still empty is trimmed to "Reading" or "Searching the web:".
  it("recognizes a line whose detail is still empty", () => {
    for (const line of ["Searching the web:", "Reading", "Running:", "Using"])
      expect(isToolActivityLine(line), line).toBe(true);
    expect(toolActivityLine("Searching the web:")).toBe("Searching the web:");
    expect(toolActivityLine("Using")).toBe("Using a tool");
    expect(vi("Using a tool", {})).toBe("Đang dùng một công cụ");
    expect(vi("Using {name}", { name: "x y" })).toBe("Đang dùng x y");
  });

  it("translates the approval card question and names the built-in tool", () => {
    expect(askCardText("Review before web_fetch → sjc.com.vn")).toBe(
      "Review before Web fetch → sjc.com.vn",
    );
    expect(askCardText("Review before GMAIL_SEND_EMAIL")).toBe("Review before GMAIL_SEND_EMAIL");
    expect(vi("Review before {action}", { action: "Tải trang web → sjc.com.vn" })).toBe(
      "Xem lại trước khi Tải trang web → sjc.com.vn",
    );
    expect(askCardText("Pick one")).toBe("Pick one");
  });
});
