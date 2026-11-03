import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("task continuity is an explicit personal preference that survives reload", async ({
  page,
}, testInfo) => {
  await signup(page, `continuity-${Date.now()}@rakazo.test`, "password12", "Task Tester");
  await completeOnboarding(page);
  await openUserSettings(page, "general");
  const toggle = page.getByRole("switch", { name: "Continue unfinished tasks", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await captureScreenshot(page, testInfo, "personal-task-continuity-enabled");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});

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
  await expect(page.getByLabel("API key", { exact: true })).toBeHidden();
  await page.getByText("Speech and dictation", { exact: true }).click();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await page.getByText("Speech and dictation", { exact: true }).click();
  await captureScreenshot(page, testInfo, "native-voice-uses-owned-chatgpt");
  await settings.getByLabel("ChatGPT voice calls", { exact: true }).selectOption("");
  await expect(settings.getByLabel("ChatGPT voice calls", { exact: true })).toHaveValue("");
  expect(credentialId).toBeNull();
});
