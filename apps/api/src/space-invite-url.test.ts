import { expect, it } from "vitest";
import { spaceInviteUrl } from "./space-invite-url.js";

it("routes a native invitation through its pinned portal with the computer and invite", () => {
  const url = new URL(
    spaceInviteUrl("fake-invite-token", {
      webOrigin: "http://127.0.0.1:34287",
      deviceId: "fake-device",
      portalOrigin: "https://portal.example.test",
    }),
  );
  expect(url.origin).toBe("https://portal.example.test");
  expect(url.pathname).toBe("/remote-join");
  expect(url.search).toBe("");
  expect(new URLSearchParams(url.hash.slice(1)).get("device")).toBe("fake-device");
  expect(new URLSearchParams(url.hash.slice(1)).get("invite")).toBe("fake-invite-token");
  expect(url.href).not.toContain("127.0.0.1");
});

it("preserves the public standalone server invitation", () => {
  expect(spaceInviteUrl("fake-token", { webOrigin: "https://server.example.test" })).toBe(
    "https://server.example.test/invite/fake-token",
  );
});

it.each([
  undefined,
  "http://portal.example.test",
  "https://portal.example.test/path",
  "https://user:pass@portal.example.test",
])(
  "refuses a native invitation with invalid portal %s instead of sharing loopback",
  (portalOrigin) => {
    expect(() =>
      spaceInviteUrl("fake-token", {
        webOrigin: "http://127.0.0.1:34287",
        deviceId: "fake-device",
        portalOrigin,
      }),
    ).toThrow();
  },
);

it("encodes invite data instead of letting it change the destination", () => {
  const token = "fake&device=other#token";
  const url = new URL(
    spaceInviteUrl(token, {
      webOrigin: "http://127.0.0.1:34287",
      deviceId: "fake-device",
      portalOrigin: "https://portal.example.test",
    }),
  );
  const values = new URLSearchParams(url.hash.slice(1));
  expect(values.getAll("device")).toEqual(["fake-device"]);
  expect(values.get("invite")).toBe(token);
});
