import { i18n } from "@lingui/core";
import { MODEL_OUTPUT_CUT_ERROR, MODEL_REQUEST_LIMIT_ERROR, normalizeRunError } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { normalizeWebRunError, translateRunError } from "./run-error";

afterEach(() => {
  i18n.activate("en");
});

it("translates connection limits while keeping model recovery", () => {
  const translated = "Das Anfragelimit dieser Verbindung ist zu niedrig. Wähle ein anderes Modell.";
  i18n.load("de", { [MODEL_REQUEST_LIMIT_ERROR]: translated });
  i18n.activate("de");
  expect(
    normalizeRunError(MODEL_REQUEST_LIMIT_ERROR, translateRunError, i18n.locale),
  ).toMatchObject({
    summary: translated,
    recovery: "model",
  });
});

it("uses the active Lingui catalog for shared run errors", () => {
  i18n.load("de", {
    "Your model provider": "Dein Modellanbieter",
    "{provider} is rate limiting requests. Try again shortly.":
      "{provider} drosselt Anfragen. Versuche es gleich noch einmal.",
  });
  i18n.activate("de");
  expect(
    normalizeRunError(
      '429: {"message":"API key rate limit exceeded"}',
      translateRunError,
      i18n.locale,
    ).summary,
  ).toBe("Dein Modellanbieter drosselt Anfragen. Versuche es gleich noch einmal.");
});

it("translates the summary of a reply cut off at the output limit", () => {
  i18n.load("de", {
    [MODEL_OUTPUT_CUT_ERROR]:
      "Das Modell hat sein Ausgabelimit erreicht, bevor es die Antwort fertig geschrieben hat.",
  });
  i18n.activate("de");
  expect(normalizeRunError(MODEL_OUTPUT_CUT_ERROR, translateRunError, i18n.locale)).toMatchObject({
    summary:
      "Das Modell hat sein Ausgabelimit erreicht, bevor es die Antwort fertig geschrieben hat.",
    recovery: "model",
  });
});

it("maps legacy funding advice to API key setup", () => {
  const current = "Connect your own API key in Models.";
  const translated = "Verbinde deinen eigenen API-Schlüssel in Modelle.";
  i18n.load("de", { [current]: translated });
  i18n.activate("de");
  for (const legacy of [
    "Connect your own API key in Models or choose Rakazo credits in Billing.",
    "Connect your own API key in Models or choose VNBot credits in Billing.",
    "Subscribe in Billing to keep running bots.",
  ]) {
    expect(normalizeRunError(legacy, translateRunError, i18n.locale)).toMatchObject({
      summary: translated,
      recovery: "connection",
    });
  }
  expect(translateRunError(current, undefined)).toBe(translated);
});

it.each(["{provider} reached its credit limit.", "{provider} reached its daily credit limit."])(
  "keeps provider credit errors as provider credit errors: %s",
  (message) => {
    i18n.load("en", {});
    i18n.activate("en");
    expect(translateRunError(message, { provider: "Your model provider" })).toBe(
      message.replace("{provider}", "Your model provider"),
    );
  },
);

it("tells a user whose own provider ran out of credits to choose a model", () => {
  i18n.load("en", {});
  i18n.activate("en");
  expect(
    normalizeWebRunError('402: {"message":"You have no credits remaining. Go to Billing."}'),
  ).toMatchObject({
    kind: "credit",
    summary: "Your model provider reached its credit limit.",
    details: "Your model provider reached its credit limit.",
    recovery: "model",
  });
});

it.each([
  "Connect your own API key in Models or choose Rakazo credits in Billing.",
  "Subscribe in Billing to keep running bots.",
  "Connect your own API key in Models.",
])("keeps API key setup for missing-key advice: %s", (error) => {
  i18n.load("en", {});
  i18n.activate("en");
  expect(normalizeWebRunError(error)).toMatchObject({
    summary: "Connect your own API key in Models.",
    details: "Connect your own API key in Models.",
    recovery: "connection",
  });
});

it("gives Vietnamese recovery advice for an app context error", () => {
  const summary = "Ngữ cảnh trò chuyện bị lỗi. Hãy thử lại hoặc bắt đầu cuộc trò chuyện mới.";
  i18n.load("vi", { "Chat context is inconsistent. Try again or start a new chat.": summary });
  i18n.activate("vi");
  expect(normalizeWebRunError("Unmatched tool result in context")).toMatchObject({
    kind: "context",
    summary,
  });
  expect(normalizeWebRunError("Unmatched tool result in context").recovery).toBeUndefined();
});
