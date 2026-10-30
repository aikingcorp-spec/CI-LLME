import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BuiltinToolNameSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_LABELS_VI, notificationText, toolLabelVi } from "./notification-text.js";
import { stuckWorkReminder, stuckWorkStoppedNotification } from "./stuck-work.js";

const root = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

describe("push notification text", () => {
  it("asks for approval in Vietnamese with the web's tool label", () => {
    expect(notificationText.needsApproval("Chief")).toBe("Chief cần bạn duyệt");
    expect(notificationText.reviewBefore("web_fetch")).toBe("Xem lại trước khi Tải trang web");
    expect(notificationText.reviewBefore("mcp__github__create_issue")).toBe(
      "Xem lại trước khi mcp__github__create_issue",
    );
    expect(notificationText.needsApproval("")).toBe("Bot cần bạn duyệt");
  });

  it("writes the stuck-work reminders and stop notices in Vietnamese", () => {
    expect(stuckWorkReminder("waiting_input", "Ada")).toEqual({
      kind: "help",
      title: "Ada vẫn cần bạn trả lời",
      body: "Việc này đang chờ bạn.",
    });
    expect(stuckWorkStoppedNotification("queued", "Ada")).toEqual({
      kind: "failure",
      title: "Ada đã dừng",
      body: "Đã dừng. Việc này nằm chờ mà không bắt đầu.",
    });
  });

  it("labels every built-in tool exactly as the web's Vietnamese catalog does", () => {
    const labels = readFileSync(root("apps/web/src/lib/builtin-tool-labels.ts"), "utf8");
    const po = readFileSync(root("apps/web/src/locales/vi/messages.po"), "utf8");
    const vi = new Map(
      [...po.matchAll(/msgid "((?:[^"\\]|\\.)*)"\nmsgstr "((?:[^"\\]|\\.)*)"/gu)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const web = [...labels.matchAll(/^\s+(\w+): \(\) => t`([^`]*)`/gmu)];
    expect(web.length).toBe(BuiltinToolNameSchema.options.length);
    for (const [, name, english] of web)
      expect(toolLabelVi(name ?? ""), name).toBe(vi.get(english ?? ""));
    expect(Object.keys(BUILTIN_TOOL_LABELS_VI).sort()).toEqual(
      [...BuiltinToolNameSchema.options].sort(),
    );
  });
});
