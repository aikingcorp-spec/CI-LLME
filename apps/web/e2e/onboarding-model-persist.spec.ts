import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { openUserSettings, rpc, signup } from "./helpers";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("the model chosen in onboarding is saved and shown as the main model", async ({ page }) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "big-pickle" }, { id: "other" }] }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    let connected = false;
    await page.route("**/rpc/me", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({
        response,
        json: { json: { ...body.json, needsModel: connected ? body.json.needsModel : true } },
      });
    });
    await signup(page, `persist-${Date.now()}@rakazo.test`, "password12", "Model setup");
    await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: "OpenAI-compatible" }).click();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(page.getByRole("combobox", { name: "Models from server" })).toContainText(
      "big-pickle",
    );
    const connect = page.waitForResponse("**/rpc/models/connect");
    connected = true;
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const connectResponse = await connect;
    expect(connectResponse.ok(), await connectResponse.text()).toBe(true);
    await page.waitForURL(/\/app\//, { timeout: 30_000 });
    const role = await rpc<{ primary: { provider: string; modelId: string } | null }>(
      page,
      "models/role",
      { role: "main" },
    );
    expect(role.primary).toMatchObject({ provider: "openai-compatible", modelId: "big-pickle" });
    // A slow role load must not show "Choose a model" as if nothing were saved.
    let releaseRole: () => void = () => {};
    const roleHeld = new Promise<void>((resolve) => {
      releaseRole = resolve;
    });
    await page.route("**/rpc/models/role", async (route) => {
      await roleHeld;
      await route.continue();
    });
    await openUserSettings(page, "models");
    const main = page.getByTestId("model-role-main");
    await expect(main.getByLabel("Loading model catalog…")).toBeVisible();
    await expect(main.getByTestId("model-role-default")).toContainText("Loading…");
    await expect(main).not.toContainText("Choose a model");
    releaseRole();
    await expect(main).toContainText("big-pickle");
    await expect(main.getByTestId("model-role-default")).toHaveCount(0);
  } finally {
    server.close();
  }
});
