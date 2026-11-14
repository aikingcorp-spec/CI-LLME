import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { i18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import {
  COMPUTER_PROVIDER_UNAVAILABLE_ERROR,
  COMPUTER_RECOVERY_REQUIRED_ERROR,
} from "@rakazo/contracts";
import {
  displayedRunErrorDetails,
  MODEL_CREDITS_EXHAUSTED_ERROR,
  MODEL_OUTPUT_CUT_ERROR,
  MODEL_REQUEST_LIMIT_ERROR,
  normalizeRunError,
} from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { translateRunError } from "./run-error";

async function loadViCatalog() {
  const filename = fileURLToPath(new URL("../locales/vi/messages.po", import.meta.url));
  const catalog = await formatter().parse(readFileSync(filename, "utf8"), {
    locale: "vi",
    sourceLocale: "en",
    filename,
  });
  const messages = Object.fromEntries(
    Object.entries(catalog).map(([id, entry]) => [id, entry.translation || entry.message || id]),
  );
  i18n.load("vi", messages);
  i18n.activate("vi");
  return messages;
}

afterEach(() => {
  i18n.load("en", {});
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

it("shows the catalog Vietnamese for a saved internal server error", async () => {
  await loadViCatalog();
  expect(normalizeRunError("Internal server error", translateRunError, i18n.locale).summary).toBe(
    "Đã có lỗi xảy ra. Hãy thử lại.",
  );
  i18n.load("en", {});
  i18n.activate("en");
  expect(normalizeRunError("Internal server error", translateRunError, i18n.locale).summary).toBe(
    "Something went wrong. Try again.",
  );
});

it("keeps chat context, a computer outage, and a model timeout as different sentences", async () => {
  await loadViCatalog();
  expect(
    normalizeRunError("Unmatched tool result in context", translateRunError, i18n.locale),
  ).toMatchObject({
    summary: "Ngữ cảnh trò chuyện bị lỗi. Hãy thử lại hoặc bắt đầu cuộc trò chuyện mới.",
    kind: "context",
  });
  expect(
    normalizeRunError(COMPUTER_PROVIDER_UNAVAILABLE_ERROR, translateRunError, i18n.locale).summary,
  ).toBe("Máy tính của bot chưa sẵn sàng. Hãy thử lại sau.");
  expect(normalizeRunError("Request timed out.", translateRunError, i18n.locale).summary).toBe(
    "Nhà cung cấp mô hình của bạn phản hồi quá lâu. Bạn hãy thử lại.",
  );
  expect(
    normalizeRunError("Please keep the context of my last message", translateRunError, i18n.locale)
      .summary,
  ).toBe("Đã có lỗi xảy ra. Hãy thử lại.");
  expect(
    normalizeRunError(MODEL_CREDITS_EXHAUSTED_ERROR, translateRunError, i18n.locale).summary,
  ).toBe(translateRunError("Connect a model in Settings before running bots."));
  const legacy = translateRunError(
    "Connect your own API key in Models or choose Rakazo credits in Billing.",
  );
  expect(legacy).not.toMatch(/rakazo/i);
  expect(legacy).toBe(translateRunError("Connect a model in Settings before running bots."));
});

it("redacts a key in the opened details of a rejected connection", async () => {
  await loadViCatalog();
  const details =
    'Headers.append: "Bearer example-key\nclient = Client(timeout=30)" is an invalid header value.';
  const shown = normalizeRunError(details, translateRunError, i18n.locale);
  expect(shown.summary).toBe(
    "Nhà cung cấp mô hình của bạn từ chối khóa API. Hãy kiểm tra cài đặt kết nối.",
  );
  expect(shown.kind).toBe("auth");
  expect(shown.recovery).toBe("connection");
  expect(displayedRunErrorDetails(shown.details)).not.toContain("example-key");
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

it("does not direct a VNBot user to hidden Billing", () => {
  for (const message of [
    MODEL_CREDITS_EXHAUSTED_ERROR,
    "Connect your own API key in Models or choose Rakazo credits in Billing.",
    "Connect your own API key in Models or choose VNBot credits in Billing.",
  ]) {
    expect(translateRunError(message)).toBe("Connect a model in Settings before running bots.");
  }
});

it("keeps legacy credit advice out of both the primary copy and opened details", async () => {
  await loadViCatalog();
  const result = normalizeRunError(
    "Connect your own API key in Models or choose Rakazo credits in Billing.",
    translateRunError,
    i18n.locale,
  );
  expect(result.summary).toBe("Bạn hãy kết nối mô hình trong Cài đặt trước khi chạy bot.");
  expect(result.details).toBe(result.summary);
  expect(result.recovery).toBe("connection");
});

it("uses the real VI catalog for a computer recovery instruction", async () => {
  await loadViCatalog();
  const result = normalizeRunError(
    COMPUTER_RECOVERY_REQUIRED_ERROR,
    translateRunError,
    i18n.locale,
  );
  expect(result.summary).toBe(
    "Chưa xác nhận được lần dừng trước. Chọn Khôi phục máy tính để tiếp tục.",
  );
  expect(result.recovery).toBeUndefined();
});
