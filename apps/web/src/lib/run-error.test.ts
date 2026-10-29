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
  expect(
    translateRunError(
      "Connect your own API key in Models or choose Rakazo credits in Billing.",
      undefined,
    ),
  ).toBe(translated);
  expect(translateRunError(current, undefined)).toBe(translated);
});

it.each(["{provider} reached its credit limit.", "{provider} reached its daily credit limit."])(
  "shows API key setup for credit errors: %s",
  (message) => {
    i18n.load("en", {});
    i18n.activate("en");
    expect(translateRunError(message, { provider: "Your model provider" })).toBe(
      "Connect your own API key in Models.",
    );
  },
);

it.each([
  '402: {"message":"You have no credits remaining. Go to Billing."}',
  "Connect your own API key in Models or choose Rakazo credits in Billing.",
  "Subscribe in Billing to keep running bots.",
])("does not expose legacy billing copy in expandable diagnostics: %s", (error) => {
  i18n.load("en", {});
  i18n.activate("en");
  expect(normalizeWebRunError(error)).toMatchObject({
    summary: "Connect your own API key in Models.",
    details: "Connect your own API key in Models.",
    recovery: "connection",
  });
});
