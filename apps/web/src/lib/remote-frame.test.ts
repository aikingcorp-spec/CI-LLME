import { expect, it } from "vitest";
import { frameEntry, frameNavigation, machinePath, remoteFramePage } from "./remote-frame";

it("keeps the computer and app page in the portal path", () => {
  expect(machinePath("fake-device", "/app/bot?settings=space")).toBe(
    "/m/fake-device/app/bot?settings=space",
  );
});
it.each([
  "//evil.test/app",
  "/api/auth",
  "/app/../../api/auth",
  "/app\\evil",
  "/app/\n",
  "javascript:alert(1)",
])("rejects host navigation %s", (path) => {
  expect(remoteFramePage(path)).toBe(false);
});
it("keeps an invitation in the frame fragment, never in the request query", () => {
  const entry = frameEntry("https://computer.example.test/remote-enter#fake-ticket", "fake-invite");
  const url = new URL(entry.href);
  expect(url.search).toBe("");
  expect(new URLSearchParams(url.hash.slice(1)).get("invite")).toBe("fake-invite");
  expect(entry.origin).toBe("https://computer.example.test");
});
it.each([
  "http://computer.example.test/remote-enter#ticket",
  "https://user:pass@computer.example.test/remote-enter#ticket",
  "https://computer.example.test/app#ticket",
  "https://computer.example.test/remote-enter?ticket=secret",
])("refuses an unsafe frame entry %s", (href) => {
  expect(() => frameEntry(href)).toThrow();
});
it("accepts navigation only from the exact window and host", () => {
  const source = {} as Window;
  const expected = { source, origin: "https://computer.example.test" };
  const event = {
    source,
    origin: expected.origin,
    data: { type: "vnbot.remote.navigation", path: "/app/bot" },
  };
  expect(frameNavigation(event, expected)).toBe("/app/bot");
  expect(frameNavigation({ ...event, origin: "https://other.example.test" }, expected)).toBeNull();
  expect(frameNavigation({ ...event, source: {} as Window }, expected)).toBeNull();
  expect(
    frameNavigation({ ...event, data: { ...event.data, path: "https://evil.test" } }, expected),
  ).toBeNull();
});

it("never embeds the identity portal as a same-origin computer", () => {
  expect(() =>
    frameEntry(
      "https://portal.example.test/remote-enter#fake-ticket",
      undefined,
      "/app",
      "https://portal.example.test",
    ),
  ).toThrow();
});
