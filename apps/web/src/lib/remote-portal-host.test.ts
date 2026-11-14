import { expect, it } from "vitest";
import { isRemotePortalHost } from "./remote-portal-host.js";

it("treats only the remote entry host as the portal", () => {
  expect(isRemotePortalHost("app.vnbot.run")).toBe(true);
  expect(isRemotePortalHost("localhost")).toBe(false);
  expect(isRemotePortalHost("vnbot.run")).toBe(false);
});
