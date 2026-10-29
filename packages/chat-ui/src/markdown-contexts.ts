// Light providers apps mount at the root. Kept apart from the markdown renderer so mounting
// them does not pull react-markdown, linkify-it or tldts into the first-load bundle.
import type { ReactNode } from "react";
import { createContext } from "react";

/** Whether remote markdown images load without a tap. Apps provide the reader's device setting. */
export const RemoteImagesContext = createContext(false);

/**
 * Where link icons come from. Apps load them through the Rakazo API, which fetches and caches
 * them, so a device never contacts the linked site or an icon service. `globe` is the native
 * fallback glyph; web draws its own.
 */
export type LinkFavicons = {
  /** Cache scope for the API serving these answers. */
  endpoint?: string;
  /** `retry` means the server was too busy to look, not that the site has no icon. */
  load(origin: string): Promise<{ icon: string | null; retry?: boolean }>;
  globe?: ReactNode;
};

export const LinkFaviconsContext = createContext<LinkFavicons | null>(null);
