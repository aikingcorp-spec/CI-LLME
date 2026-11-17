import { i18n } from "@lingui/core";
import {
  COMPUTER_RECOVERY_REQUIRED_ERROR,
  CONNECTOR_AUTH_UNAVAILABLE,
  MCP_OAUTH_CLIENT_REQUIRED,
} from "@rakazo/contracts";
import { MODEL_IMAGE_INPUT_ERROR } from "@rakazo/core";
import { beforeEach, describe, expect, it } from "vitest";
import { authErrorText, errorText } from "./user-error";

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});

describe("authErrorText", () => {
  it("maps PASSWORD_AUTH_DISABLED before the server message", () => {
    expect(
      authErrorText({ code: "PASSWORD_AUTH_DISABLED", message: "Server message" }, "Fallback"),
    ).toBe("Password sign-in is turned off on this server");
  });

  it("maps email code failures", () => {
    expect(authErrorText({ code: "INVALID_OTP", message: "Invalid OTP" }, "Fallback")).toBe(
      "Invalid code",
    );
    for (const code of ["OTP_EXPIRED", "TOO_MANY_ATTEMPTS"]) {
      expect(authErrorText({ code, message: "Server message" }, "Fallback")).toBe(
        "Request a new code",
      );
    }
    expect(
      authErrorText(
        { code: "TOO_MANY_REQUESTS", message: "Too many attempts. Try again later." },
        "Fallback",
      ),
    ).toBe("Too many attempts. Try again in a few minutes.");
    expect(authErrorText({ status: 429, message: "Rate limited" }, "Fallback")).toBe(
      "Too many attempts. Try again in a few minutes.",
    );
  });

  it("replaces Better Auth's raw too-long password message with the limit", () => {
    expect(
      authErrorText({ code: "PASSWORD_TOO_LONG", message: "Password too long" }, "Fallback"),
    ).toBe("Password must be 128 characters or fewer");
  });

  it("maps EMAIL_NOT_INVITED to the not approved notice", () => {
    expect(
      authErrorText(
        { code: "EMAIL_NOT_INVITED", message: "This email is not invited yet" },
        "Fallback",
      ),
    ).toBe("This email is not approved for VNBot yet");
  });

  it("says when a deactivated account tries to sign in", () => {
    expect(authErrorText({ code: "ACCOUNT_DEACTIVATED" }, "Fallback")).toBe(
      "This account is deactivated",
    );
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

it("shows copy for an app whose auth is not set up, never the provider response", () => {
  const error = Object.assign(new Error('400 {"error":{"slug":"ToolRouterV2_NoManagedAuth"}}'), {
    code: CONNECTOR_AUTH_UNAVAILABLE,
  });
  expect(errorText(error, "Could not connect")).toBe(
    "This app needs its own sign-in setup to connect.",
  );
});

it("asks for an OAuth client ID when the server cannot register one", () => {
  const error = Object.assign(new Error("Incompatible auth server"), {
    code: MCP_OAUTH_CLIENT_REQUIRED,
  });
  expect(errorText(error, "Could not sign in")).toBe("Needs an OAuth client ID");
});

it("keeps a recovery conflict separate from a model or key problem", () => {
  expect(errorText({ code: "CONFLICT", message: COMPUTER_RECOVERY_REQUIRED_ERROR })).toBe(
    COMPUTER_RECOVERY_REQUIRED_ERROR,
  );
});
