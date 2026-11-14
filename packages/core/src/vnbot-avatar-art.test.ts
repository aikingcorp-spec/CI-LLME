import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_AVATAR_COLOR } from "./bot-avatar-colors.js";
import { VNBOT_AVATAR_SVG, VNBOT_SHAPES } from "./vnbot-avatar-art.js";
import { paintVnbotAvatarSvg, resolveVnbotPortrait, vnbotShape } from "./vnbot-portrait.js";

const currentDir = join(dirname(fileURLToPath(import.meta.url)), "../../ui-web/src/vnbot-avatars");
const approved = {
  non: "d0684b5ae8256011dde7a60e881e84ce727b00b2eac73c2d8bd136754613e46f",
  chung: "29e5a6c51f9a836311d1e96256896d2a96994ab63a3dc9c82dc847eebc224000",
  aodai: "19993a9241504c68e2bea0c64ee7503c34f2d2bcc080360ed9da133259b4f7ec",
  ran: "527278cc0f1957aab86c0379dc3200643d4ad971ef399efa52daf52639f6ab32",
  sen: "737bd46a9beeeed39017c96dd177fd7ce5d00bf882678fc4b9dc61923bea366b",
};

describe("approved VNBot artwork", () => {
  it("keeps each shape byte-identical to old VNBot and to the shared registry", () => {
    for (const shape of VNBOT_SHAPES) {
      const current = readFileSync(join(currentDir, `${shape}.svg`));
      expect(createHash("sha256").update(current).digest("hex")).toBe(approved[shape]);
      expect(VNBOT_AVATAR_SVG[shape]).toBe(current.toString("utf8"));
    }
  });

  it("paints only a hex body colour into the approved paths", () => {
    const painted = paintVnbotAvatarSvg("sen", "#14b8a6");
    expect(painted).toContain('fill="#14b8a6"');
    expect(painted).not.toContain("var(--body");
    expect(painted).toContain(
      'd="M128 40 C150 62 178 78 196 120 C210 160 196 206 128 206 C60 206 46 160 60 120 C78 78 106 62 128 40 Z"',
    );
    const hostile = `"><script>alert(1)</script>`;
    const rejected = paintVnbotAvatarSvg("ran", hostile);
    expect(rejected).not.toContain("script");
    expect(rejected).not.toContain("<img");
    expect(rejected).toContain(`fill="${DEFAULT_BOT_AVATAR_COLOR}"`);
    expect(rejected).toContain(VNBOT_AVATAR_SVG.ran.match(/d="([^"]+)"/)?.[1]);
  });

  it("selects the same mascot for a saved VNBot shape and a legacy plain value", () => {
    expect(
      resolveVnbotPortrait({ identity: "agent-1", color: "#10B981::shape_4", avatarSet: "vnbot" }),
    ).toEqual({ shape: "sen", body: "#10B981" });
    expect(
      resolveVnbotPortrait({ identity: "agent-1", color: "#10B981", avatarSet: "rakazo" }),
    ).toEqual({ shape: vnbotShape("agent-1"), body: "#10B981" });
    expect(
      resolveVnbotPortrait({ identity: "agent-1", color: "#10B981::shape_4", avatarSet: "rakazo" }),
    ).toBeNull();
    expect(
      resolveVnbotPortrait({
        identity: "agent-1",
        color: "data:image/png;base64,YQ==",
        avatarSet: "vnbot",
      }),
    ).toBeNull();
    expect(resolveVnbotPortrait({ identity: "agent-1", color: "", avatarSet: "vnbot" })?.body).toBe(
      "#F97316",
    );
  });
});
