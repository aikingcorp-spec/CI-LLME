import { describe, expect, it } from "vitest";
import { notificationAvatarSource } from "./notification-avatar.js";
import { VNBOT_AVATAR_SVG } from "./vnbot-avatar-art.js";
import { resolveVnbotPortrait, vnbotShape } from "./vnbot-portrait.js";

function svg(source: string): string {
  return decodeURIComponent(source.slice(source.indexOf(",") + 1));
}

describe("notificationAvatarSource", () => {
  it("uses the approved VNBot paths and the stored body colour", () => {
    const bot = { id: "agent-1", color: "#14b8a6::shape_4", avatarSet: "vnbot" as const };
    const portrait = resolveVnbotPortrait({
      identity: bot.id,
      color: bot.color,
      avatarSet: bot.avatarSet,
    });
    const image = svg(notificationAvatarSource(bot));
    expect(portrait).toEqual({ shape: "sen", body: "#14b8a6" });
    expect(image).toContain('viewBox="0 0 256 256"');
    expect(image).toContain('fill="#14b8a6"');
    for (const path of VNBOT_AVATAR_SVG.sen.match(/d="([^"]+)"/g) ?? []) {
      expect(image).toContain(path);
    }
    const legacy = {
      id: "agent-1",
      color: "#14b8a6",
      avatarSet: "rakazo" as const,
    };
    const legacyImage = svg(notificationAvatarSource(legacy));
    const shape = vnbotShape(legacy.id);
    for (const path of VNBOT_AVATAR_SVG[shape].match(/d="([^"]+)"/g) ?? []) {
      expect(legacyImage).toContain(path);
    }
  });

  it("returns an uploaded photo unchanged", () => {
    const photo = "data:image/png;base64,YQ==";
    expect(notificationAvatarSource({ id: "agent-1", color: photo, avatarSet: "vnbot" })).toBe(
      photo,
    );
    expect(notificationAvatarSource({ id: "agent-1", color: photo, avatarSet: "rakazo" })).toBe(
      photo,
    );
  });

  it("keeps a Classic shape on the shipped silhouette", () => {
    const source = svg(
      notificationAvatarSource({
        id: "agent-1",
        color: "#8B5CF6::shape_3",
        avatarSet: "rakazo",
      }),
    );
    expect(source).toContain('viewBox="-15 -15 259 259"');
    expect(source).not.toContain("vnbot-icon");
  });
});
