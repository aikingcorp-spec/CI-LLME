import { parseBotAvatarValue } from "@rakazo/contracts";
import {
  DEFAULT_BOT_AVATAR_COLOR,
  resolvePersonaColorDef,
  shippedHash,
} from "./bot-avatar-colors.js";
import type { VnbotShape } from "./vnbot-avatar-art.js";
import { VNBOT_AVATAR_SVG, VNBOT_SHAPES } from "./vnbot-avatar-art.js";

const AVATAR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const BODY_VAR = /var\(--body,#[0-9A-Fa-f]{3,8}\)/g;

export interface VnbotPortrait {
  shape: VnbotShape;
  body: string;
}

/** Same identity hash the 0.3.9 picker uses, so a bot keeps its mascot. */
export function vnbotShape(identity: string): VnbotShape {
  const index = shippedHash(`vnbot-avatar/shape/v1/${identity}`) % VNBOT_SHAPES.length;
  return VNBOT_SHAPES[index] ?? "non";
}

/**
 * Bake a body colour into one approved SVG. Only a hex reaches the markup.
 * Anything else keeps a fixed fallback and is not concatenated into the document.
 */
export function paintVnbotAvatarSvg(shape: VnbotShape, body: string): string {
  const fill = AVATAR_HEX.test(body) ? body : DEFAULT_BOT_AVATAR_COLOR;
  return VNBOT_AVATAR_SVG[shape].replace(BODY_VAR, () => fill);
}

/**
 * The mascot chat and notifications both draw. A photo, a Classic shape, and an
 * organic body return null. A plain legacy `rakazo` value is the VNBot mascot.
 * A stored hex is kept, including older palette values.
 */
export function resolveVnbotPortrait(input: {
  identity: string;
  color: string;
  avatarSet?: string | null;
}): VnbotPortrait | null {
  const parsed = parseBotAvatarValue(input.color || "#F97316");
  if (parsed.kind === "image") return null;
  const shapeIndex = parsed.kind === "shape" ? parsed.shapeIndex : undefined;
  const color = parsed.kind === "other" ? parsed.raw : parsed.color;
  const drawsVnbot =
    input.avatarSet === "vnbot" || (input.avatarSet === "rakazo" && shapeIndex === undefined);
  if (!drawsVnbot) return null;
  const identity = input.identity || color || "agent";
  const body = AVATAR_HEX.test(color) ? color : resolvePersonaColorDef(identity, color).hex;
  const shape =
    shapeIndex === undefined
      ? vnbotShape(identity)
      : (VNBOT_SHAPES[shapeIndex % VNBOT_SHAPES.length] ?? "non");
  return { shape, body };
}
