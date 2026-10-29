/**
 * External VNBot links shown in the UI. One place, so marketing can move a
 * form without a code search. `VITE_VNBOT_CONTACT_URL` overrides the default
 * at build time (for staging or a localized form).
 */
const DEFAULT_CONTACT_URL = "https://aikingx.com";

function httpsUrl(raw: string | undefined, fallback: string): string {
  const value = raw?.trim();
  if (!value) return fallback;
  try {
    return new URL(value).protocol === "https:" ? value : fallback;
  } catch {
    return fallback;
  }
}

/** The "Talk to Us" form behind "Get in touch" on the not-invited panel. */
export const VNBOT_CONTACT_URL = httpsUrl(
  import.meta.env.VITE_VNBOT_CONTACT_URL,
  DEFAULT_CONTACT_URL,
);

export const VNBOT_DOCS_URL = "https://vnbot.run";
