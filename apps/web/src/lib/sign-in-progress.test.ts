// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  clearSignInProgress,
  readSignInProgress,
  resendSecondsLeft,
  SIGN_IN_PROGRESS_KEY,
  writeSignInProgress,
} from "./sign-in-progress";

afterEach(() => sessionStorage.clear());

it("round-trips the code step while it is fresh", () => {
  writeSignInProgress({ email: "a@b.vn", step: "code", sentAt: 1_000 });
  expect(readSignInProgress(31_000)).toEqual({ email: "a@b.vn", step: "code", sentAt: 1_000 });
});

it("falls back to the email step when the code step is stale or has no timestamp", () => {
  writeSignInProgress({ email: "a@b.vn", step: "code", sentAt: 0 });
  expect(readSignInProgress(11 * 60 * 1000)).toEqual({ email: "a@b.vn", step: "email" });
  sessionStorage.setItem(SIGN_IN_PROGRESS_KEY, JSON.stringify({ email: "a@b.vn", step: "code" }));
  expect(readSignInProgress()).toEqual({ email: "a@b.vn", step: "email" });
});

it("ignores junk and clears", () => {
  sessionStorage.setItem(SIGN_IN_PROGRESS_KEY, "{not json");
  expect(readSignInProgress()).toBeNull();
  writeSignInProgress({ email: "a@b.vn", step: "email" });
  clearSignInProgress();
  expect(readSignInProgress()).toBeNull();
});

it("computes the remaining resend seconds", () => {
  expect(resendSecondsLeft(0, 60, 15_000)).toBe(45);
  expect(resendSecondsLeft(0, 60, 61_000)).toBe(0);
  expect(resendSecondsLeft(undefined, 60)).toBe(0);
});
