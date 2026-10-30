import { prefixSvgIds } from "@rakazo/ui-web/svg-ids";
import type { CSSProperties } from "react";
import { useId } from "react";
import aodaiSvg from "../assets/vnbot/aodai.svg?raw";
import chungSvg from "../assets/vnbot/chung.svg?raw";
import nonSvg from "../assets/vnbot/non.svg?raw";
import ranSvg from "../assets/vnbot/ran.svg?raw";
import senSvg from "../assets/vnbot/sen.svg?raw";

const MASCOTS = [
  { name: "non", svg: nonSvg, body: "var(--vnbot-body-la-ma)", light: false },
  { name: "chung", svg: chungSvg, body: "var(--vnbot-body-la-dong)", light: false },
  { name: "aodai", svg: aodaiSvg, body: "var(--vnbot-body-kem-lua)", light: true },
  { name: "ran", svg: ranSvg, body: "var(--vnbot-body-cham-ran)", light: false },
  { name: "sen", svg: senSvg, body: "var(--vnbot-body-hong-sen)", light: true },
] as const;

function Mascot({
  name,
  svg,
  body,
  light,
}: {
  name: string;
  svg: string;
  body: string;
  light: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const html = prefixSvgIds(svg, `${uid}-${name}`).replace(
    "<svg ",
    '<svg width="100%" height="100%" ',
  );
  return (
    <span
      data-body-tone={light ? "light" : undefined}
      className="block size-full"
      style={{ "--body": body } as CSSProperties}
      // Static brand SVG. Ids are prefixed so copies on one page do not collide.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: brand asset, not user content
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function VnbotMascot({
  name,
  className,
}: {
  name: (typeof MASCOTS)[number]["name"];
  className?: string;
}) {
  const mascot = MASCOTS.find((entry) => entry.name === name) ?? MASCOTS[0];
  return (
    <span className={`block ${className ?? ""}`} aria-hidden="true">
      <Mascot {...mascot} />
    </span>
  );
}

/** The five welcome mascots. Decorative; each SVG's ids are prefixed so they do not collide. */
export function VnbotMascotRow({ className, size }: { className?: string; size: string }) {
  return (
    <div className={className} aria-hidden="true">
      {MASCOTS.map((mascot) => (
        <span key={mascot.name} className={`block ${size}`}>
          <Mascot {...mascot} />
        </span>
      ))}
    </div>
  );
}
