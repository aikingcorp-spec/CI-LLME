import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

for (const prefix of ["vnbot-plugin-connect", "vnbot-app-connect", "rakazo-mcp-oauth"]) {
  test(`${prefix}: reserved blank popup reaches provider and callback`, async () => {
    const state = randomUUID();
    const name = `${prefix}:${state}`;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url?.startsWith("/callback")) {
        response.end(
          `<script>new BroadcastChannel('popup-fixture').postMessage('${state}')</script>Callback received`,
        );
      } else {
        response.end(`<button id="connect">Connect</button><script>
          const channel=new BroadcastChannel('popup-fixture');
          channel.onmessage=e=>document.body.dataset.completed=e.data;
          document.querySelector('button').onclick=()=>{
            window.reserved=window.open('about:blank',${JSON.stringify(name)},'popup,width=560,height=720');
            document.body.dataset.opened=String(Boolean(window.reserved));
          };
        </script>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(path.join(tmpdir(), "desktop-popup-"));
    const executable = process.env.DESKTOP_POPUP_TEST_EXECUTABLE;
    const sandboxArgs = process.platform === "darwin" ? [] : ["--no-sandbox"];
    const app = await electron.launch({
      ...(executable
        ? { executablePath: executable, args: sandboxArgs }
        : { args: [".", ...sandboxArgs] }),
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        RAKAZO_WEB_URL: origin,
        RAKAZO_DISABLE_BUNDLED_RENDERER: "1",
        RAKAZO_DISABLE_AUTO_UPDATE: "1",
        RAKAZO_PERFORMANCE_USER_DATA: profile,
      },
    });
    try {
      const main = await app.firstWindow();
      await expect(main.locator("#connect")).toBeVisible();
      const childPromise = app.waitForEvent("window");
      await main.locator("#connect").click();
      await expect(main.locator("body")).toHaveAttribute("data-opened", "true");
      const child = await childPromise;
      await child.route("https://provider.example.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<a href="${origin}/callback?state=${state}">Authorize fixture</a>`,
        }),
      );
      await main.evaluate(() => {
        const popup = (window as typeof window & { reserved: Window }).reserved;
        popup.location.replace("https://provider.example.test/authorize");
      });
      await expect(child.getByText("Authorize fixture")).toBeVisible();
      await child.screenshot({ path: test.info().outputPath("oauth-provider.png") });
      expect(
        await child.evaluate(() => ({
          process: typeof process,
          bridge: "rakazoDesktop" in window,
        })),
      ).toEqual({ process: "undefined", bridge: false });
      const preferences = await app.evaluate(({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows();
        const parent = windows.find((w) => w.webContents.getURL().startsWith("http://127.0.0.1"));
        const popup = windows.find((w) =>
          w.webContents.getURL().startsWith("https://provider.example.test"),
        );
        const prefs = popup!.webContents.getLastWebPreferences();
        return {
          sandbox: prefs.sandbox,
          isolated: prefs.contextIsolation,
          node: prefs.nodeIntegration,
          hasPreload: Boolean(prefs.preload),
          sameSession: popup!.webContents.session === parent!.webContents.session,
        };
      });
      expect(preferences).toMatchObject({
        sandbox: true,
        isolated: true,
        node: false,
        hasPreload: false,
        sameSession: true,
      });
      await child.getByText("Authorize fixture").click();
      await expect(child.getByText("Callback received")).toBeVisible();
      await expect(main.locator("body")).toHaveAttribute("data-completed", state);
      expect(await main.evaluate(() => window.open("about:blank", "unknown-popup") === null)).toBe(
        true,
      );
      await child.close();
    } finally {
      if (process.platform === "darwin") {
        // Context.close closes pages first; the normal Mac warm-window handler
        // intentionally hides them. Exercise actual Quit before context teardown.
        const closed = app.waitForEvent("close", { timeout: 10_000 });
        await app.evaluate(({ app }) => {
          setImmediate(() => app.quit());
        });
        await closed;
      } else {
        await app.close();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
  });
}
