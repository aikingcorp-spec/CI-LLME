import type { Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  readSignInCode,
  signInWithEmailCode,
  signup,
  signupThroughForm,
} from "./helpers";

test("sign-up stays blank until session and sign-in options are ready", async ({
  page,
}, testInfo) => {
  let releaseSession = () => {};
  let releaseCapabilities = () => {};
  const sessionReady = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const capabilitiesReady = new Promise<void>((resolve) => {
    releaseCapabilities = resolve;
  });
  await page.route("**/api/auth/get-session**", async (route) => {
    await sessionReady;
    await route.fulfill({ json: null });
  });
  await page.route("**/api/auth/capabilities", async (route) => {
    await capabilitiesReady;
    await route.fulfill({
      json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
    });
  });

  await page.goto("/sign-up");
  await expect(page.locator('[data-rakazo-app-state="session-pending"]')).toBeVisible();
  await expect(page.locator("#root")).toHaveText("");
  await captureScreenshot(page, testInfo, "signup-session-pending");

  const capabilitiesRequested = page.waitForRequest("**/api/auth/capabilities");
  releaseSession();
  await capabilitiesRequested;
  await expect(page.locator('[data-rakazo-app-state="ready"]')).toBeVisible();
  await expect(page.locator("#root")).toHaveText("");
  await captureScreenshot(page, testInfo, "signup-options-pending");

  releaseCapabilities();
  await expect(page.getByRole("heading", { name: "Get started with VNBot" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "signup-ready");
});

for (const mode of ["sign-in", "sign-up", "sso-only"] as const) {
  test(`SSO is ${mode === "sso-only" ? "primary" : "secondary"} on ${mode}`, async ({
    page,
  }, testInfo) => {
    await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
    await page.route("**/api/auth/capabilities", (route) =>
      route.fulfill({
        json: {
          passwordAuth: mode !== "sso-only",
          sso: { name: "Example", availability: "available" },
          passwordReset: false,
          resetUrl: null,
        },
      }),
    );
    await page.goto(mode === "sign-up" ? "/sign-up" : "/sign-in");
    const sso = page.getByRole("button", { name: "Continue with Example" });
    await expect(sso).toBeVisible();
    if (mode === "sso-only") {
      await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
      await expect(sso).toHaveClass(/w-full/);
    } else {
      const submit = page.locator('button[type="submit"]');
      const primaryBounds = await submit.boundingBox();
      const ssoBounds = await sso.boundingBox();
      expect(ssoBounds!.y).toBeGreaterThan(primaryBounds!.y + primaryBounds!.height);
      await expect(sso).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await captureScreenshot(page, testInfo, `auth-${mode}-sso`);
  });
}

test("an email that is not invited stays on the email step", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: true,
        emailCode: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
      },
    }),
  );
  await page.route("**/send-verification-otp", (route) =>
    route.fulfill({
      status: 403,
      json: { code: "EMAIL_NOT_INVITED", message: "This email is not invited yet" },
    }),
  );
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill("mai@vnbot.vn");
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("VNBot is in limited preview");
  await expect(page.getByLabel("6-digit sign-in code")).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("mai@vnbot.vn");
  const contact = page.getByRole("link", { name: "Get in touch (opens in new tab)" });
  await expect(contact).toHaveAttribute("href", "https://aikingx.com");
  await expect(contact).toHaveAttribute("target", "_blank");
  await expect(contact).toHaveAttribute("rel", "noopener noreferrer");
  await captureScreenshot(page, testInfo, "not-invited");
});

test("sign-in keeps the code step across a reload and switches language in place", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        passwordAuth: true,
        emailCode: true,
        sso: null,
        passwordReset: false,
        resetUrl: null,
      },
    }),
  );
  await page.route("**/send-verification-otp", (route) =>
    route.fulfill({ json: { success: true } }),
  );
  await page.goto("/sign-in");
  const email = page.getByLabel("Email", { exact: true });
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  const describedBy = await email.getAttribute("aria-describedby");
  await expect(page.locator(`#${describedBy}`)).toHaveText("Enter a valid email address.");
  await email.fill("lan@vnbot.vn");
  await expect(email).not.toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByText("lan@vnbot.vn")).toBeVisible();

  // Keyboard-only language switch (email-otp spec §6.6).
  await page.getByRole("button", { name: /^Language: / }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitemradio", { name: "Tiếng Việt" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Kiểm tra email của bạn" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  expect(await page.evaluate(() => localStorage.getItem("rakazo.uiLocale"))).toBe("vi");
});

test("signed-out welcome fits a narrow phone and offers sign in", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: { passwordAuth: true, sso: null, passwordReset: false, resetUrl: null },
    }),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "VNBot", level: 1 })).toBeVisible();
  await expect(main.getByRole("button", { name: /^Get started/ })).toBeVisible();
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 320);
  await captureScreenshot(page, testInfo, "logged-out-welcome-phone");
  await main.getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Get started with VNBot" })).toBeVisible();
});

test("logout protects bot deep links and sign-in restores the session", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const email = `auth-lifecycle-${stamp}@rakazo.test`;
  const password = "password12";
  const userName = "Auth Lifecycle";

  await page.goto("/sign-in");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username webauthn");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);

  await signupThroughForm(page, email, password, userName);
  await completeOnboarding(page);

  await page.waitForURL(/\/app\/[^/]+$/);
  const protectedBotPath = new URL(page.url()).pathname;
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await captureScreenshot(page, testInfo, "36-account-menu");

  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ status: 500, body: "" }), {
    times: 1,
  });
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not log out. Try again." }),
  ).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "36-account-menu-logout-error");
  await page.unroute("**/api/auth/sign-out");

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Sign-out usually overlaps a bot refresh that the server rejects; wait for every
  // refresh that started so an unhandled rejection would surface before the assertion.
  const refreshes: Promise<unknown>[] = [];
  const trackRefresh = (request: Request) => {
    if (request.url().includes("/rpc/spaces/list")) refreshes.push(request.response());
  };
  page.on("request", trackRefresh);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Get started with VNBot" })).toBeVisible();
  page.off("request", trackRefresh);
  await Promise.all(refreshes);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
  expect(pageErrors).toEqual([]);
  await page.goto("/");
  await expect(page.locator('[data-rakazo-surface="welcome"]')).toBeVisible();
  await expect(page.getByText(/Your team of always-on bots/)).toBeVisible();
  await page.getByRole("button", { name: /^Get started/ }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Get started with VNBot" })).toBeVisible();
  await page.goto("/");
  await captureScreenshot(page, testInfo, "37-logged-out-welcome");

  await page.goto(protectedBotPath);
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await expect(page.getByRole("heading", { name: "Get started with VNBot" })).toBeVisible();
  await expect(page.getByText("Chief", { exact: true })).toHaveCount(0);
  await expect(page.getByText(userName, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username webauthn");
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "38-protected-deep-link-sign-in");

  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await page.getByLabel("6-digit sign-in code").fill("000000");
  await expect(page.getByRole("alert")).toContainText("That code isn't right");
  // The deep link rides along as ?next= so sign-in can restore it.
  await expect(page).toHaveURL((url) => {
    return url.pathname === "/sign-in" && url.searchParams.get("next") === protectedBotPath;
  });
  await captureScreenshot(page, testInfo, "39-invalid-credentials");

  await page.getByLabel("6-digit sign-in code").fill(await readSignInCode(page, email));
  await page.waitForURL((url) => url.pathname === protectedBotPath, {
    timeout: 20_000,
  });
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await expect(composer).toHaveAttribute("name", "chat-message");
  await expect(composer).toHaveAttribute("autocomplete", "off");
  await expect(composer).toHaveAttribute("aria-label", "Message Chief");
  await expect(page.getByRole("button", { name: new RegExp(userName, "i") })).toBeVisible();

  await composer.fill("line one");
  const heightBeforeNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  await composer.press("Shift+Enter");
  await composer.type("line two");
  await expect(composer).toHaveValue("line one\nline two");
  const heightWithNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  expect(heightWithNewline).toBeGreaterThan(heightBeforeNewline);

  await composer.press("Enter");
  const multilineMessage = page
    .getByTestId("transcript")
    .getByText("line one\nline two", { exact: true });
  await expect(multilineMessage).toBeVisible();
  await expect(multilineMessage).toHaveCSS("white-space", "pre-wrap");

  const message = "Fake composer regression check.";
  await composer.fill(message);
  // The transcript is optimistic; wait for the previous send to finish before
  // testing Enter again, just as the enabled Send control requires.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "40-restored-auth-session");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  // Scope to the transcript: the sidebar activity row can echo the same text.
  await expect(page.getByTestId("transcript").getByText(message, { exact: true })).toBeVisible();
});

test("changes and recovers an email password", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const email = `password-recovery-${stamp}@rakazo.test`;
  const originalPassword = "password12";
  const changedPassword = "changed-password12";
  const userName = "Password Recovery";

  await signup(page, email, originalPassword, userName);
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("sidebar-search-trigger").click();
  await expect(page.getByTestId("sidebar-search").locator("input")).toHaveAttribute(
    "autocomplete",
    "off",
  );
  await expect(page.getByTestId("sidebar-search").locator("input")).toHaveAttribute(
    "name",
    "sidebar-search",
  );

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByLabel("Current password")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "general-settings");
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(settings.locator('input[name="username"]')).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await expect(settings.locator('input[name="username"]')).toHaveValue(email);
  await expect(settings.getByLabel("Current password")).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await expect(settings.getByLabel("New password")).toHaveAttribute("autocomplete", "new-password");
  await expect(settings.getByLabel("New password")).toHaveAttribute("minlength", "8");
  await expect(settings.getByLabel("Current password")).not.toHaveAttribute("minlength");
  await expect(settings.getByLabel("Confirm password")).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await settings.getByLabel("Current password").fill(originalPassword);
  await settings.getByLabel("New password").fill(changedPassword);
  await settings.getByLabel("Confirm password").fill(changedPassword);
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByText("Password updated")).toBeVisible();
  await expect(settings.getByLabel("Current password")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "41-password-changed");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Get started with VNBot" })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "42-signed-out-email-code");
  await signInWithEmailCode(page, email);
  await page.waitForURL(/\/app(?:\/|$)/);
});

test("password-off account settings hide password changes and retain password deletion", async ({
  page,
}, testInfo) => {
  await signup(page, `password-off-${Date.now()}@rakazo.test`, "password12", "Password Off");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.route("**/api/auth/account-security", (route) =>
    route.fulfill({
      json: {
        hasPassword: true,
        passwordChangeEnabled: false,
        freshOidcAuth: false,
        ssoLinked: true,
        emailDeletion: true,
        sso: { name: "Example" },
      },
    }),
  );
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("button", { name: "Change password", exact: true })).toHaveCount(
    0,
  );
  await settings.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(settings.getByLabel("Current password", { exact: true })).toBeVisible();
  await expect(settings.getByLabel("New password", { exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Send deletion code" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "password-off-account-settings");
});
