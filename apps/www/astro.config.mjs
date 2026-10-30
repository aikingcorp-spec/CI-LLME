import { defineConfig } from "astro/config";
import { resolveWwwPort } from "./www-port.mjs";

const wwwPort = resolveWwwPort();

export default defineConfig({
  site: "https://vnbot.run",
  output: "static",
  i18n: {
    defaultLocale: "vi",
    locales: ["vi", "en"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  // The static public/sitemap.xml is the sitemap.
  integrations: [],
  server: {
    host: "127.0.0.1",
    port: wwwPort,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: wwwPort,
  },
});
