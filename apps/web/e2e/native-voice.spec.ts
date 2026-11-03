import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("native calls select an owned ChatGPT connection while keeping speech settings separate", async ({
  page,
}, testInfo) => {
  await signup(page, `native-voice-${Date.now()}@rakazo.test`, "password12", "Voice Tester");
  await completeOnboarding(page);
  let credentialId: string | null = null;
  let voiceId = "cove";
  await page.route("**/rpc/voice/realtime/status", (route) =>
    route.fulfill({
      json: {
        json: { enabled: Boolean(credentialId), credentialId, voiceId, voices: ["cove", "maple"] },
      },
    }),
  );
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "owned-oauth",
            provider: "openai-codex",
            label: "My ChatGPT",
            hasKey: true,
            isDefault: true,
            authKind: "oauth",
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/voice/realtime/configure", (route) => {
    const body = route.request().postDataJSON().json;
    credentialId = body.credentialId;
    voiceId = body.voiceId;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await openUserSettings(page, "voice");
  const settings = page.getByTestId("native-voice-settings");
  await settings.getByLabel("ChatGPT voice calls", { exact: true }).selectOption("owned-oauth");
  await expect(settings.getByLabel("Voice", { exact: true })).toHaveValue("cove");
  await settings.getByLabel("Voice", { exact: true }).selectOption("maple");
  await expect(settings.getByLabel("Voice", { exact: true })).toHaveValue("maple");
  await expect(
    settings.getByText(
      "Uses your ChatGPT account. Voice availability and limits follow your plan.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "native-voice-uses-owned-chatgpt");
  await settings.getByRole("button", { name: "Turn off voice calls", exact: true }).click();
  await expect(settings.getByLabel("ChatGPT voice calls", { exact: true })).toHaveValue("");
  expect(credentialId).toBeNull();
});
