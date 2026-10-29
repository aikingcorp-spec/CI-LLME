/// <reference path="./svg-raw.d.ts" />
import type { VnbotBodyTone } from "@rakazo/core";
import { shippedHash, vnbotBodyTone } from "@rakazo/core";
import type { CSSProperties } from "react";
import { useId } from "react";
import { prefixSvgIds } from "./svg-ids.js";
import aodaiSvg from "./vnbot-avatars/aodai.svg?raw";
import chungSvg from "./vnbot-avatars/chung.svg?raw";
import nonSvg from "./vnbot-avatars/non.svg?raw";
import ranSvg from "./vnbot-avatars/ran.svg?raw";
import senSvg from "./vnbot-avatars/sen.svg?raw";

export const VNBOT_SHAPES = ["non", "chung", "aodai", "ran", "sen"] as const;
export type VnbotShape = (typeof VNBOT_SHAPES)[number];

const SHAPE_SVG: Record<VnbotShape, string> = {
  non: nonSvg,
  chung: chungSvg,
  aodai: aodaiSvg,
  ran: ranSvg,
  sen: senSvg,
};

/** Hash of the bot id, so the same bot always wears the same mascot. */
export function vnbotShape(identity: string): VnbotShape {
  return VNBOT_SHAPES[shippedHash(`vnbot-avatar/shape/v1/${identity}`) % VNBOT_SHAPES.length]!;
}

function sized(svg: string): string {
  return svg.replace("<svg ", '<svg width="100%" height="100%" ');
}

export function VnbotAvatar({
  shape,
  body,
  tone,
  size,
  className,
}: {
  shape: VnbotShape;
  body: string;
  tone?: VnbotBodyTone;
  size: number;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const resolvedTone = tone ?? vnbotBodyTone(body);
  const html = sized(prefixSvgIds(SHAPE_SVG[shape], uid));
  return (
    <div
      className={className}
      data-vnbot-avatar=""
      data-vnbot-shape={shape}
      data-body-tone={resolvedTone === "light" ? "light" : undefined}
      style={{ "--body": body, width: size, height: size } as CSSProperties}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: brand asset, not user content
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
