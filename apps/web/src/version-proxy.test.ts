import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("proxies /version to the API in the dev and preview servers", () => {
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const proxied = config.slice(config.indexOf("const apiProxy"), config.indexOf("].map((path)"));
  expect(proxied).toContain('"/version"');
});
