import { expect, it } from "vitest";
import { newAccountDestination, remoteEnterDestination, signInNext } from "./sign-in-next.js";

it("returns to integration setup, plugin admin, MCP sign-in and invite links only", () => {
  expect(signInNext("/integrations/setup")).toBe("/integrations/setup");
  expect(signInNext("/admin/plugins")).toBe("/admin/plugins");
  expect(signInNext("/mcp/oauth/callback?code=c&state=s")).toBe(
    "/mcp/oauth/callback?code=c&state=s",
  );
  expect(signInNext("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(signInNext("/remote-join")).toBe("/remote-join");
  expect(signInNext("/remote-join?invite=abc")).toBeNull();
  expect(signInNext("/remote-join/extra")).toBeNull();
  expect(signInNext("/join/0b8f3c1e-7a2d-4e6b-9c1f-2d3e4f5a6b7c")).toBe(
    "/join/0b8f3c1e-7a2d-4e6b-9c1f-2d3e4f5a6b7c",
  );
  expect(signInNext("/join/abc/../../app")).toBeNull();
  expect(signInNext(null)).toBeNull();
  expect(signInNext("/app")).toBeNull();
  expect(signInNext("https://example.com/invite/abc")).toBeNull();
  expect(signInNext("//example.com/invite/abc")).toBeNull();
  expect(signInNext("/invite/abc/../../app")).toBeNull();
  expect(signInNext("/invite/")).toBeNull();
});

it("starts a new account in onboarding unless it came for an invite, invitation, or host handoff", () => {
  expect(newAccountDestination("/invite/abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(newAccountDestination("/join/abc_DEF-123")).toBe("/join/abc_DEF-123");
  expect(newAccountDestination("/remote-join")).toBe("/remote-join");
  expect(newAccountDestination("/integrations/setup")).toBe("/onboarding");
  expect(newAccountDestination(null)).toBe("/onboarding");
});

it("opens a remote invite in the app and drops a token that is not a local invite", () => {
  expect(remoteEnterDestination("abc_DEF-123")).toBe("/invite/abc_DEF-123");
  expect(remoteEnterDestination(undefined)).toBe("/app");
  expect(remoteEnterDestination("")).toBe("/app");
  expect(remoteEnterDestination("../app")).toBe("/app");
  expect(remoteEnterDestination("abc/../../app")).toBe("/app");
});
