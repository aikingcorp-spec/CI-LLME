import { MODEL_IMAGE_INPUT_ERROR } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { authErrorText, errorText, modelConnectionErrorText } from "./user-error";

describe("authErrorText", () => {
  it("maps PASSWORD_AUTH_DISABLED before the server message", () => {
    expect(
      authErrorText({ code: "PASSWORD_AUTH_DISABLED", message: "Server message" }, "Fallback"),
    ).toBe("Password sign-in is turned off on this server");
  });

  it("maps email code failures", () => {
    expect(authErrorText({ code: "INVALID_OTP", message: "Invalid OTP" }, "Fallback")).toBe(
      "That code isn't right. Check your email and try again.",
    );
    for (const code of ["OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]) {
      expect(authErrorText({ code, message: "Server message" }, "Fallback")).toBe(
        "This code has expired. Send a new one to continue.",
      );
    }
  });

  it("maps EMAIL_NOT_INVITED from the auth error body", () => {
    expect(
      authErrorText(
        { code: "EMAIL_NOT_INVITED", message: "This email is not invited yet" },
        "Fallback",
      ),
    ).toBe("VNBot is in limited preview");
  });

  it("maps ACCOUNT_NOT_LINKED and Better Auth's account_not_linked", () => {
    for (const code of ["ACCOUNT_NOT_LINKED", "account_not_linked"]) {
      expect(authErrorText({ code, message: "Server message" }, "Fallback")).toBe(
        "This email already has an account. Sign in with an email code, then link SSO in Settings.",
      );
    }
  });

  it("replaces Better Auth's raw too-long password message with the limit", () => {
    expect(
      authErrorText({ code: "PASSWORD_TOO_LONG", message: "Password too long" }, "Fallback"),
    ).toBe("Password must be 128 characters or fewer");
  });

  it("keeps messages from older servers", () => {
    expect(authErrorText({ message: "Registration is closed" }, "Fallback")).toBe(
      "Registration is closed",
    );
  });
});

it("recognizes image compatibility errors from old clients and new servers", () => {
  expect(errorText(new Error(MODEL_IMAGE_INPUT_ERROR))).toBe(MODEL_IMAGE_INPUT_ERROR);
  expect(errorText(`  ${MODEL_IMAGE_INPUT_ERROR}  `)).toBe(MODEL_IMAGE_INPUT_ERROR);
});

it.each([
  "Connect your own API key in Models or choose Rakazo credits in Billing.",
  "Subscribe in Billing to keep running bots.",
  '402: {"message":"Insufficient credits"}',
])("uses model connection advice for funding errors on sends: %s", (message) => {
  expect(errorText(new Error(message))).toBe("Connect your own API key in Models.");
});

describe("model server address errors", () => {
  it.each([
    "Could not reach the model server. Check the server URL.",
    "Model server did not respond in time. Check the server URL.",
    "Model server returned 404. Check the server URL.",
  ])("recognises %s", (message) => {
    expect(modelConnectionErrorText(message)).toContain("Check the server URL");
    expect(errorText(new Error(message))).toBe(modelConnectionErrorText(message));
  });
});
