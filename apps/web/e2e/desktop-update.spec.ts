import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("desktop update can be checked, deferred, and installed from settings", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    let installAttempts = 0;
    let checks = 0;
    let state = {
      phase: "idle",
      currentVersion: "0.1.2",
      availableVersion: null as string | null,
      percent: null as number | null,
      message: null as string | null,
      checkedAt: "2026-01-01T00:00:00.000Z",
    };
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => state,
          check: async () => {
            if (++checks === 1) {
              state = { ...state, checkedAt: "2026-01-01T00:01:00.000Z" };
              return state;
            }
            state = { ...state, phase: "downloading", availableVersion: "0.1.3", percent: 50 };
            setTimeout(() => {
              state = { ...state, phase: "ready", percent: 100 };
            }, 3_000);
            return state;
          },
          install: async () => {
            if (++installAttempts <= 2) {
              state = { ...state, message: null };
              setTimeout(() => {
                state = {
                  ...state,
                  message: "The update could not be completed. Try again later.",
                };
              }, 100);
              return state;
            }
            state = { ...state, message: null };
            document.documentElement.dataset.updateInstalled = "true";
            return state;
          },
        },
      },
    });
  });
  await page.addInitScript(() => localStorage.setItem("rakazo.uiLocale", "en"));
  const stamp = Date.now();
  await signup(page, `desktop-update-${stamp}@rakazo.test`, "password12", "Update Tester");
  await completeOnboarding(page);
  await expect(page.getByRole("complementary", { name: "Desktop update" })).toHaveCount(0);
  await openUserSettings(page, "updates");
  const settings = page.getByTestId("desktop-update-settings");
  await expect(settings.getByText("v0.1.2")).toBeVisible();
  await expect(settings.getByText("Up to date", { exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(settings.getByRole("status")).toHaveText("Up to date");
  await settings.getByRole("button", { name: "Check for updates" }).click();
  await expect(settings.getByRole("button", { name: "Downloading…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("complementary", { name: "Desktop update" });
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await captureScreenshot(page, testInfo, "desktop-update-ready");
  await prompt.getByRole("button", { name: "Restart to update" }).click();
  await expect(prompt.getByRole("status")).toHaveText(
    "The update could not be completed. Try again later.",
  );
  await prompt.getByRole("button", { name: "Restart to update" }).click();
  await expect(prompt.getByRole("status")).toHaveText(
    "The update could not be completed. Try again later.",
  );
  await prompt.getByRole("button", { name: "Later" }).click();
  await expect(prompt).toHaveCount(0);
  await openUserSettings(page, "updates");
  await expect(settings.getByRole("button", { name: "Restart to update" })).toBeVisible();
  await settings.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "desktop-update-settings");
  await settings.getByRole("button", { name: "Restart to update" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-update-installed", "true");
});

test("a browser installation shows its update state without a desktop bridge", async ({
  page,
}, testInfo) => {
  let checks = 0;
  let applies = 0;
  await page.route("**/rpc/updater/status", (route) =>
    route.fulfill({
      json: {
        json: {
          supported: false,
          unsupportedReason: null,
          installKind: "source",
          manualCommands: [
            "Download a newer VNBot package from the place you installed this one, then start it again.",
          ],
          mode: "unavailable",
          strategy: null,
          strategyNote: null,
          version: "",
          revision: "abc1234def89",
          commit: "abc1234def89",
          branch: null,
          remoteUrl: null,
          dirty: false,
          dirtyPaths: [],
          image: null,
          imageTag: null,
          previousImageTag: null,
          canRollback: false,
          source: { repoUrl: "", branch: "", official: false },
          officialRepoUrl: "",
          restartSupervisor: "none",
          restartAdvice: "",
          running: false,
          lastRun: null,
        },
      },
    }),
  );
  await page.route("**/rpc/updater/check", (route) => {
    checks += 1;
    return route.fulfill({
      json: {
        json: {
          status: "unavailable",
          reason: "unconfigured",
          changed: [],
          commit: null,
          targetCommit: null,
          targetTag: null,
          behindBy: 0,
        },
      },
    });
  });
  await page.route("**/rpc/updater/apply", (route) => {
    applies += 1;
    return route.fulfill({ status: 403, json: { code: "FORBIDDEN" } });
  });
  const stamp = Date.now();
  await signup(page, `server-update-${stamp}@rakazo.test`, "password12", "Update Tester");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "updates");
  const server = settings.getByTestId("server-update-settings");
  await expect(server.getByText("Build abc1234def89")).toBeVisible();
  await expect(
    server.getByText(
      "Download a newer VNBot package from the place you installed this one, then start it again.",
    ),
  ).toBeVisible();
  await expect(server.getByText("Up to date", { exact: true })).toHaveCount(0);
  await expect(server.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
  await expect(settings.getByTestId("desktop-update-settings")).toHaveCount(0);
  await server.getByRole("button", { name: "Check for updates" }).click();
  await expect.poll(() => checks).toBe(1);
  await server.getByRole("button", { name: "Check for updates" }).click();
  await expect.poll(() => checks).toBe(2);
  expect(applies).toBe(0);
  await expect(server.getByText("Up to date", { exact: true })).toHaveCount(0);
  await server.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "server-update-settings");
});
