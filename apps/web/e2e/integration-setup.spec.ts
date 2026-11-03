import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("task completion checks are a personal opt-in with visible model usage", async ({
  page,
}, testInfo) => {
  await signup(page, `task-continuity-${Date.now()}@rakazo.test`, "password12", "Task Tester");
  await completeOnboarding(page);
  await openUserSettings(page, "general");
  const control = page.getByRole("switch", { name: "Continue unfinished tasks", exact: true });
  await expect(control).not.toBeChecked();
  await control.click();
  await expect(control).toBeChecked();
  const response = await page.request.post("/rpc/me", { data: { json: null } });
  expect((await response.json()).json.taskContinuityEnabled).toBe(true);
  await expect(
    page.getByText("Checks for remaining work before stopping. Uses extra model requests.", {
      exact: true,
    }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "personal-task-continuity-enabled");
  await control.click();
  await expect(control).not.toBeChecked();
});

test("signup never grants server authority and settings contain only account controls", async ({
  page,
}, testInfo) => {
  await signup(page, `ordinary-account-${Date.now()}@rakazo.test`, "password12", "Test Account");
  await completeOnboarding(page);
  const me = await page.request.post("/rpc/me", { data: { json: null } });
  expect((await me.json()).json.isDeploymentOwner).toBe(false);
  for (const [path, input] of [
    ["deployment/update", { signupsEnabled: true }],
    ["updater/apply", {}],
    ["security/events", {}],
  ] as const) {
    expect((await page.request.post(`/rpc/${path}`, { data: { json: input } })).status()).toBe(403);
  }
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
  await expect(page.getByRole("link", { name: "Server integrations", exact: true })).toBeHidden();
  await expect(page.getByTestId("settings-nav-updates")).toBeHidden();
  await captureScreenshot(page, testInfo, "account-settings-without-server-admin");
});

test("personal Composio setup checks and clears the key without exposing server administration", async ({
  page,
}, testInfo) => {
  await signup(page, `personal-broker-${Date.now()}@rakazo.test`, "password12", "Personal Broker");
  await completeOnboarding(page);
  let configured = false;
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: !configured,
          webUrl: "https://example.test/integrations/setup",
          providers: [{ id: "composio", configured }],
        },
      },
    }),
  );
  await page.route("**/rpc/integrationSetup/save", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: { provider: "composio", apiKey: "fake-personal-key" },
    });
    configured = true;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.goto("/integrations/setup");
  await page.getByText("Connect with your Composio key", { exact: true }).click();
  const key = page.getByLabel("Your Composio API key", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("fake-personal-key");
  await page.getByRole("button", { name: "Check and save", exact: true }).click();
  await expect(page.getByText("Composio connected", { exact: true })).toBeVisible();
  await expect(key).toHaveValue("");
  await captureScreenshot(page, testInfo, "personal-composio-configured");
});

test("ordinary accounts can add personal MCP connections without server setup", async ({
  page,
}, testInfo) => {
  await signup(page, `personal-mcp-${Date.now()}@rakazo.test`, "password12", "Personal MCP");
  await completeOnboarding(page);
  await page.goto("/integrations/setup");
  await expect(page.getByRole("heading", { name: "Add MCP server" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search apps", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  for (const name of ["Composio", "Pipedream", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await page.route("**/rpc/capabilities/catalogSearch", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          results: [
            {
              domain: "notion.example.test",
              name: "Notion",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "notion",
                  source: "https://mcp.notion.example.test/mcp",
                  auth: null,
                },
              ],
            },
          ],
        },
      },
    }),
  );
  await page.route("**/rpc/mcp/oauth/begin", (route) =>
    route.fulfill({ json: { json: { status: "already_connected" } } }),
  );
  await page.getByRole("textbox", { name: "Search apps", exact: true }).fill("Notion");
  await page.getByRole("button", { name: "Search integrations.sh", exact: true }).click();
  await expect(page.getByText("Notion", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "personal-mcp-without-server-admin");
});
