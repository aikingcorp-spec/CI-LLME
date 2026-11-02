import { expect, it } from "vitest";
import { screenSocketPath } from "./screen-path.js";

const prefix = "/novnc/session/view/1234567890000.fixturefixturefixture";
it.each(["websockify", `${prefix}/websockify`])("resolves an API-issued socket path %s", (path) => {
  const page = new URL(`https://app.example.test${prefix}/embed.html`);
  page.searchParams.set("path", path);
  expect(screenSocketPath(page.href)).toBe(`${prefix}/websockify`);
});
it.each([
  "../websockify",
  "https://elsewhere.test/websockify",
  "//elsewhere.test/websockify",
  "/rpc/me",
  `${prefix}different/websockify`,
])("refuses socket path outside its page capability %s", (path) => {
  const page = new URL(`https://app.example.test${prefix}/embed.html`);
  page.searchParams.set("path", path);
  expect(() => screenSocketPath(page.href)).toThrow();
});
