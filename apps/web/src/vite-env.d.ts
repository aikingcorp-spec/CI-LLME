/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_UI_LOCALE?: string;
  /** "Get in touch" link on the not-invited sign-in panel (https only). Defaults to https://aikingx.com. */
  readonly VITE_VNBOT_CONTACT_URL?: string;
  /** Build id (`YYYYMMDDHHMMSS`) of a production build; empty on the dev server. */
  readonly RAKAZO_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.po" {
  export const messages: Record<string, unknown>;
}
