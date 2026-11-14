import { notificationAvatarSource, VNBOT_SHAPES, vnbotShape } from "@rakazo/core";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

type Attributes = Record<string, string>;

function tags(svg: string, name: string): Attributes[] {
  return Array.from(svg.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g")), (tag) =>
    Object.fromEntries(
      Array.from(tag[1]!.matchAll(/([\w:-]+)="([^"]*)"/g), (attribute) => [
        attribute[1]!,
        attribute[2]!,
      ]),
    ),
  );
}

function portraitSvg(source: string): string {
  return decodeURIComponent(source.slice(source.indexOf(",") + 1));
}

it.each<[string, { color: string; avatarSet?: "organic" | "rakazo" }]>([
  ["organic", { color: "#14b8a6" }],
  ["shipped shape", { color: "#8B5CF6::shape_3" }],
])("draws the %s notification portrait from the chat avatar's geometry", (_, avatar) => {
  const bot = { id: "agent-1", ...avatar };
  const source = notificationAvatarSource(bot);
  const portrait = portraitSvg(source);
  const chat = renderToString(
    <BotAvatar color={bot.color} identity={bot.id} avatarSet={bot.avatarSet} activity="idle" />,
  );

  const [svg] = tags(portrait, "svg");
  expect(tags(chat, "svg")).toContainEqual(expect.objectContaining({ viewBox: svg!.viewBox }));
  const [body] = tags(portrait, "path");
  expect(tags(chat, "path")).toContainEqual(expect.objectContaining(body!));
  for (const transform of tags(portrait, "g").flatMap((group) => group.transform ?? [])) {
    expect(chat).toContain(`transform="${transform}"`);
  }
  const eyes = [...tags(portrait, "rect"), ...tags(portrait, "ellipse")];
  expect(eyes).toHaveLength(2);
  const chatEyes = [...tags(chat, "rect"), ...tags(chat, "ellipse")];
  for (const eye of eyes) expect(chatEyes).toContainEqual(expect.objectContaining(eye));
});

it.each<[string, { color: string; avatarSet: "vnbot" | "rakazo"; shape: string }]>([
  ["vnbot shape", { color: "#14b8a6::shape_1", avatarSet: "vnbot", shape: "chung" }],
  ["legacy plain", { color: "#14b8a6", avatarSet: "rakazo", shape: vnbotShape("agent-1") }],
])("draws the %s notification from the same VNBot artwork as chat", (_, avatar) => {
  const bot = { id: "agent-1", color: avatar.color, avatarSet: avatar.avatarSet };
  const source = notificationAvatarSource(bot);
  const portrait = portraitSvg(source);
  const chat = renderToString(
    <BotAvatar color={bot.color} identity={bot.id} avatarSet={bot.avatarSet} />,
  );
  expect(VNBOT_SHAPES).toContain(avatar.shape);
  expect(chat).toContain(`data-vnbot-shape="${avatar.shape}"`);
  expect(chat).toContain("--body:#14b8a6");
  expect(portrait).toContain('fill="#14b8a6"');
  expect(portrait).not.toContain("var(--body");
  const [svg] = tags(portrait, "svg");
  expect(tags(chat, "svg")).toContainEqual(expect.objectContaining({ viewBox: svg!.viewBox }));
  const portraitPaths = tags(portrait, "path").map((path) => path.d);
  expect(portraitPaths.length).toBeGreaterThan(0);
  expect(tags(chat, "path").map((path) => path.d)).toEqual(expect.arrayContaining(portraitPaths));
  for (const eye of tags(portrait, "use")) {
    expect(tags(chat, "use")).toContainEqual(
      expect.objectContaining({ x: eye.x, y: eye.y, width: eye.width, height: eye.height }),
    );
  }
});

it("keeps an uploaded photo as the notification and the chat avatar", () => {
  const photo = "data:image/png;base64,YQ==";
  for (const avatarSet of ["vnbot", "rakazo"] as const) {
    expect(notificationAvatarSource({ id: "agent-1", color: photo, avatarSet })).toBe(photo);
    const chat = renderToString(
      <BotAvatar color={photo} identity="agent-1" avatarSet={avatarSet} />,
    );
    expect(chat).toContain(`src="${photo}"`);
    expect(chat).not.toContain("data-vnbot-avatar");
  }
});
