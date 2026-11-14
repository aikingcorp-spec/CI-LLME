import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account voice uses an eligible saved connection and can be turned off", async ({
  page,
}, testInfo) => {
  await signup(page, `account-voice-${Date.now()}@rakazo.test`, "password12", "Voice fixture");
  await completeOnboarding(page);
  let credentialId: string | null = null;
  let voiceId = "cove";
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "linked",
            provider: "fixture",
            label: "Saved account",
            hasKey: false,
            isDefault: false,
            supportsAccountVoice: true,
          },
          {
            id: "speech",
            provider: "fixture",
            label: "Text connection",
            hasKey: true,
            isDefault: false,
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/voice/realtime/status", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: credentialId !== null,
          credentialId,
          voiceId,
          voices: ["cove", "ember"],
        },
      },
    }),
  );
  await page.route("**/rpc/voice/realtime/configure", async (route) => {
    const input = route.request().postDataJSON().json;
    expect(Object.keys(input).sort()).toEqual(["credentialId", "voiceId"]);
    credentialId = input.credentialId;
    voiceId = input.voiceId;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  const settings = await openUserSettings(page, "voice");
  const account = settings.getByRole("combobox", { name: "Account voice", exact: true });
  await expect(account).toBeVisible();
  await expect(account.getByRole("option", { name: "Text connection", exact: true })).toHaveCount(
    0,
  );
  await expect(
    settings
      .getByTestId("native-voice-settings")
      .getByRole("combobox", { name: "Voice", exact: true }),
  ).toHaveCount(0);
  await account.selectOption("linked");
  const voice = settings
    .getByTestId("native-voice-settings")
    .getByRole("combobox", { name: "Voice", exact: true });
  await expect(voice).toBeVisible();
  await voice.selectOption("ember");
  await expect(voice).toHaveValue("ember");
  await captureScreenshot(page, testInfo, "account-voice-settings");
  await account.selectOption("");
  await expect(voice).toHaveCount(0);
  await expect(account).toHaveValue("");
});
