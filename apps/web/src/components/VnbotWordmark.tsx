import { brandAssetPath, PRODUCT_DISPLAY_NAME } from "../brand/product-display";
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
  return (
    <img
      src={brandAssetPath(variant, appearance)}
      alt={PRODUCT_DISPLAY_NAME}
      className={className}
    />
  );
}
