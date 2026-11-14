import type { VnbotBodyTone, VnbotShape } from "@rakazo/core";
import { VNBOT_AVATAR_SVG, VNBOT_SHAPES, vnbotBodyTone, vnbotShape } from "@rakazo/core";
import type { CSSProperties } from "react";
import { useId } from "react";
import { prefixSvgIds } from "./svg-ids.js";

export type { VnbotShape };
export { VNBOT_SHAPES, vnbotShape };

// Inline dimensions override Button's descendant SVG sizing, as the upstream avatars do.
function sized(svg: string): string {
  return svg.replace(
    "<svg ",
    '<svg width="100%" height="100%" style="width:100%;height:100%;display:block" ',
  );
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
  const fill = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(body) ? body : undefined;
  const resolvedTone = tone ?? vnbotBodyTone(fill ?? "");
  const html = sized(prefixSvgIds(VNBOT_AVATAR_SVG[shape], uid));
  return (
    <div
      className={className}
      data-vnbot-avatar=""
      data-vnbot-shape={shape}
      data-body-tone={resolvedTone === "light" ? "light" : undefined}
      style={
        {
          ...(fill ? { "--body": fill } : {}),
          width: size,
          height: size,
        } as CSSProperties
      }
      // biome-ignore lint/security/noDangerouslySetInnerHtml: approved mascot SVG, colour stays in CSS
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
