import { useResolvedAppearance } from "../lib/use-resolved-appearance";

/** Theme-specific wordmark. Served as an image so its internal ids never meet another SVG. */
export function VnbotWordmark({
  variant,
  className,
}: {
  variant: "wordmark" | "powered" | "leaf";
  className?: string;
}) {
  const appearance = useResolvedAppearance();
  const file =
    variant === "leaf"
      ? `vnbot-leaf-${appearance}.svg`
      : variant === "powered"
        ? `vnbot-wordmark-powered-${appearance}.svg`
        : `vnbot-wordmark-${appearance}.svg`;
  return <img src={`/brand/${file}`} alt="VNBot" className={className} />;
}
