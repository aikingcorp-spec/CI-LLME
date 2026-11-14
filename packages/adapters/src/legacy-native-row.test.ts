import { expect, it } from "vitest";
import { legacyNativeBaselineTransform } from "./legacy-native-row.js";

it("keeps old upstream fields until its data migrations run", async () => {
  const thread = { id: "thread", unread: true, lastReadSeq: 4 };
  const bot = {
    id: "bot",
    title: "",
    selfUpdateInstructions: false,
    pendingInstructionsRunId: null,
  };
  expect(await legacyNativeBaselineTransform("threads", thread)).toEqual(thread);
  expect(await legacyNativeBaselineTransform("bots", bot)).toEqual(bot);
});
it("defers the separate UI preference and author while retaining their source rows", async () => {
  const user = { id: "member", locale: "en", uiLocale: "vi", taskContinuityEnabled: false };
  const message = { id: "message", authorUserId: "member", blocks: [] };
  expect(await legacyNativeBaselineTransform("user", user)).toEqual({ id: "member", locale: "en" });
  expect(await legacyNativeBaselineTransform("messages", message)).toEqual({
    id: "message",
    blocks: [],
  });
  expect(user.uiLocale).toBe("vi");
  expect(message.authorUserId).toBe("member");
});
it("defers personal credential conversion and excludes the obsolete allowlist", async () => {
  const row = { userId: "member", ciphertext: "stored", revision: 7 };
  expect(await legacyNativeBaselineTransform("user_integration_provider_configs", row)).toBeNull();
  expect(
    await legacyNativeBaselineTransform("auth_email_allowlist", { email: "member@example.test" }),
  ).toBeNull();
  expect(row.ciphertext).toBe("stored");
});
it("leaves unknown fields visible to the strict importer", async () => {
  const row = { id: "record", unknown: "must keep" };
  expect(await legacyNativeBaselineTransform("another_table", row)).toEqual(row);
});
