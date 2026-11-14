import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { SpaceMembersSchema } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import { captureScreenshot, completeOnboarding, rpc } from "./helpers";

// The harness stores sign-in codes in this outbox. Reading it is the fixture's delivery, not a mailbox.
const SIGN_IN_CODE = /(?:Your VNBot sign-in code|Mã đăng nhập VNBot của bạn): (\d{6})/;

type SignedIn = { kind: "email-code"; code: string } | { kind: "password" };

function isId(value: unknown): value is { id: string } {
  return Boolean(
    value && typeof value === "object" && "id" in value && typeof value.id === "string",
  );
}

function inviteNext(url: string, invitePath: string) {
  const parsed = new URL(url);
  expect(parsed.pathname).toBe("/sign-in");
  expect(parsed.searchParams.get("next")).toBe(invitePath);
}

async function latestSignInCode(page: Page, email: string): Promise<string | null> {
  const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";
  const response = await page.request.get(`${emailApi}/__e2e/emails`);
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) return null;
  const codes = body.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (!("to" in item) || item.to !== email) return [];
    if (!("text" in item) || typeof item.text !== "string") return [];
    const code = item.text.match(SIGN_IN_CODE)?.[1];
    return code ? [code] : [];
  });
  return codes.at(-1) ?? null;
}

async function waitForSignInCode(page: Page, email: string, previous: string | null) {
  let code = "";
  await expect
    .poll(async () => {
      code = (await latestSignInCode(page, email)) ?? "";
      return code !== "" && code !== (previous ?? "");
    })
    .toBe(true);
  return code;
}

async function rememberName(page: Page, name: string) {
  const result = await page.evaluate(async (nextName) => {
    const response = await fetch("/api/auth/update-user", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: nextName }),
    });
    return { status: response.status, body: await response.text() };
  }, name);
  expect(result.status, result.body).toBeLessThan(400);
}

async function visibleAuth(page: Page): Promise<SignedIn["kind"]> {
  const codeHeading = page.getByRole("heading", { name: "Get started with VNBot" });
  const passwordHeading = page.getByRole("heading", { name: "Sign in to VNBot" });
  await expect(codeHeading.or(passwordHeading)).toBeVisible();
  return (await codeHeading.isVisible()) ? "email-code" : "password";
}

async function submitEmailCode(page: Page, email: string, previous: string | null) {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const code = await waitForSignInCode(page, email, previous);
  await page.locator('input[autocomplete="one-time-code"]').fill(code);
  return code;
}

/** Changes the address on the code step. The invite stays in the address bar. */
async function changeEmailOnCodeStep(page: Page, from: string, invitePath: string) {
  await page.getByLabel("Email").fill(from);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  inviteNext(page.url(), invitePath);
  // Source string. The English catalog does not own this label.
  await page.getByRole("button", { name: "Đổi email khác", exact: true }).click();
  await expect(page.getByLabel("Email")).toHaveValue(from);
  inviteNext(page.url(), invitePath);
}

async function submitPasswordAccount(
  page: Page,
  input: { email: string; name: string; password: string; invitePath?: string },
) {
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  if (input.invitePath) {
    await page.waitForURL((url) => url.pathname === "/sign-up");
    expect(new URL(page.url()).searchParams.get("next")).toBe(input.invitePath);
  }
  await page.getByLabel("Name").fill(input.name);
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password", { exact: true }).fill(input.password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
}

/**
 * Signs in through the form that is actually on screen.
 * An invite path must be reached by the app. This function does not open that path again.
 */
async function enterAccount(
  page: Page,
  input: { email: string; name: string; password: string; invitePath?: string },
): Promise<SignedIn> {
  if (input.invitePath) inviteNext(page.url(), input.invitePath);
  else await page.goto("/sign-in");
  const kind = await visibleAuth(page);
  test.info().annotations.push({
    type: "fixture-auth",
    description:
      kind === "email-code"
        ? "Sign-in code from the e2e outbox. Not a mailbox and not the trial."
        : "Password form on this server. Not an email code.",
  });
  if (kind === "email-code") {
    if (input.invitePath) {
      await changeEmailOnCodeStep(page, `unused.${input.email}`, input.invitePath);
    }
    const code = await submitEmailCode(page, input.email, null);
    await land(page, input.invitePath);
    await rememberName(page, input.name);
    if (!input.invitePath) await completeOnboarding(page);
    return { kind, code };
  }
  await submitPasswordAccount(page, input);
  await land(page, input.invitePath);
  await rememberName(page, input.name);
  if (!input.invitePath) await completeOnboarding(page);
  return { kind: "password" };
}

async function land(page: Page, invitePath: string | undefined) {
  if (invitePath) {
    await page.waitForURL((url) => url.pathname === invitePath);
    return;
  }
  await page.waitForURL(/\/(onboarding|app)(?:\/|$)/);
}

async function signInAgain(
  page: Page,
  input: { email: string; password: string; invitePath: string; previousCode: string | null },
) {
  await page.waitForURL((url) => url.pathname === "/sign-in");
  inviteNext(page.url(), input.invitePath);
  const kind = await visibleAuth(page);
  if (kind === "email-code") {
    await submitEmailCode(page, input.email, input.previousCode);
  } else {
    await page.getByLabel("Email").fill(input.email);
    await page.getByLabel("Password", { exact: true }).fill(input.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.waitForURL((url) => url.pathname === input.invitePath);
}

async function openBotInSpace(page: Page, spaceId: string, botId: string, name: string) {
  await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), spaceId);
  await page.goto(`/app/${botId}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByTestId("message-user-bubble").filter({ hasText: text })).toBeVisible();
}

test("an invite stays with its own account through sign-in, then opens that space", async ({
  browser,
}, testInfo) => {
  // Three code deliveries plus the shared chat do not fit the default two minutes.
  test.setTimeout(180_000);
  const owner = await browser.newContext();
  const invitee = await browser.newContext();
  const late = await browser.newContext();
  const ownerPage = await owner.newPage();
  const inviteePage = await invitee.newPage();
  const latePage = await late.newPage();
  await owner.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stamp = Date.now();
  const password = "password12";
  const ownerEmail = `share-owner-${stamp}@rakazo.test`;
  const inviteeEmail = `share-invitee-${stamp}@rakazo.test`;
  const lateEmail = `share-late-${stamp}@rakazo.test`;

  await enterAccount(ownerPage, {
    email: ownerEmail,
    name: "Ada Owner",
    password,
  });
  const createdHome: unknown = await rpc(ownerPage, "spaces/create", { name: "Home" });
  const createdPrivate: unknown = await rpc(ownerPage, "spaces/create", { name: "Ada Private" });
  if (!isId(createdHome) || !isId(createdPrivate)) {
    throw new Error("spaces/create did not return a space id");
  }
  const home = createdHome;
  const privateSpace = createdPrivate;
  const createdSecret: unknown = await ownerPage.request
    .post("/rpc/bots/create", {
      headers: { "x-rakazo-space-id": privateSpace.id },
      data: {
        json: {
          name: "Ada Secret",
          title: "",
          description: "",
          notifyOnFinish: true,
          computerMode: "team",
        },
      },
    })
    .then(async (response) => {
      expect(response.ok()).toBe(true);
      const body: unknown = await response.json();
      return body && typeof body === "object" && "json" in body ? body.json : null;
    });
  if (!isId(createdSecret)) throw new Error("bots/create did not return the private bot");

  await ownerPage.reload();
  const ownerSidebar = ownerPage.locator("aside").first();
  await ownerSidebar.getByRole("button", { name: "Actions for Home" }).click();
  await ownerPage.getByRole("menuitem", { name: "Settings" }).click();
  const ownerSettings = ownerPage.getByTestId("user-settings");
  await expect(ownerSettings).toHaveAttribute("data-settings-section", "space");
  await expect(ownerSettings.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(ownerSettings.getByText("Owner", { exact: true })).toBeVisible();
  await expect(ownerSettings.getByRole("button", { name: "Leave space" })).toHaveCount(0);
  await ownerSettings.getByRole("button", { name: "Mời" }).click();
  const copied = ownerPage.getByText("Invite link copied");
  const linkField = ownerPage.getByLabel("Invite link");
  await expect(copied.or(linkField)).toBeVisible();
  const inviteUrl = (await copied.isVisible())
    ? await ownerPage.evaluate(() => navigator.clipboard.readText())
    : await linkField.inputValue();
  expect(inviteUrl).toMatch(/\/invite\//);
  await captureScreenshot(ownerPage, testInfo, "space-members-owner");
  const invitePath = new URL(inviteUrl).pathname;

  const inHome = { "x-rakazo-space-id": home.id };
  const post = async (path: string, json: unknown) => {
    const response = await ownerPage.request.post(`/rpc/${path}`, {
      headers: inHome,
      data: { json },
    });
    expect(response.ok()).toBe(true);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("json" in body) || !isId(body.json)) {
      throw new Error(`${path} returned no id`);
    }
    return body.json;
  };
  const bot = await post("bots/create", {
    name: "Family",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const planner = await post("bots/create", {
    name: "Planner",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
    color: "#2A92FE",
  });

  let acceptCalls = 0;
  inviteePage.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/rpc/spaces/invites/accept")) {
      acceptCalls += 1;
    }
  });
  await inviteePage.goto(invitePath);
  await inviteePage.waitForURL((url) => url.pathname === "/sign-in");
  const inviteeSession = await enterAccount(inviteePage, {
    email: inviteeEmail,
    name: "Bob Invitee",
    password,
    invitePath,
  });
  await expect(inviteePage.getByRole("heading", { name: "Tham gia Home" })).toBeVisible();
  await expect(inviteePage.getByText("Ada Owner đã mời bạn")).toBeVisible();
  await expect(
    inviteePage.getByText("Thành viên cùng thấy các cuộc trò chuyện, bot và trí nhớ ở đây"),
  ).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-invite");

  const originalViewport = inviteePage.viewportSize();
  await inviteePage.evaluate(() => localStorage.setItem("rakazo.uiLocale", "vi"));
  await inviteePage.reload();
  await expect(inviteePage.getByRole("heading", { name: "Tham gia Home" })).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-invite-vi-desktop");
  await inviteePage.setViewportSize({ width: 390, height: 844 });
  expect(await inviteePage.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
    false,
  );
  await captureScreenshot(inviteePage, testInfo, "space-invite-vi-phone");
  await inviteePage.getByTestId("account-menu").click();
  await expect(inviteePage.getByRole("menuitem", { name: "Đăng xuất", exact: true })).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-invite-account-vi-phone");
  await inviteePage.keyboard.press("Escape");
  if (originalViewport) await inviteePage.setViewportSize(originalViewport);
  await inviteePage.evaluate(() => localStorage.setItem("rakazo.uiLocale", "en"));
  await inviteePage.reload();
  await expect(inviteePage.getByRole("heading", { name: "Tham gia Home" })).toBeVisible();

  await inviteePage.getByTestId("account-menu").click();
  await inviteePage.getByRole("menuitem", { name: "Log out" }).click();
  await signInAgain(inviteePage, {
    email: inviteeEmail,
    password,
    invitePath,
    previousCode: inviteeSession.kind === "email-code" ? inviteeSession.code : null,
  });
  await expect(inviteePage.getByRole("heading", { name: "Tham gia Home" })).toBeVisible();

  // A blocked preview is a route abort, not a server outage.
  await inviteePage.route("**/rpc/spaces/invites/preview", (route) => route.abort("failed"));
  await inviteePage.reload();
  await expect(inviteePage.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(inviteePage.getByTestId("account-menu")).toBeVisible();
  await inviteePage.unroute("**/rpc/spaces/invites/preview");
  await inviteePage.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(inviteePage.getByRole("heading", { name: "Tham gia Home" })).toBeVisible();

  expect(acceptCalls).toBe(0);
  await expect(inviteePage.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await inviteePage.getByRole("button", { name: "Cancel", exact: true }).click();
  await inviteePage.waitForURL(/\/app/);
  expect(acceptCalls).toBe(0);
  // The session already exists. This return is Cancel's way back, not the sign-in proof.
  await inviteePage.goto(invitePath);
  await expect(inviteePage.getByRole("heading", { name: "Tham gia Home" })).toBeVisible();
  expect(acceptCalls).toBe(0);

  await inviteePage.evaluate((id) => localStorage.setItem("rakazo:space-id", id), privateSpace.id);
  await inviteePage.getByRole("button", { name: "Tham gia", exact: true }).click();
  await inviteePage.waitForURL(/\/app/);
  expect(acceptCalls).toBe(1);
  await expect
    .poll(() => inviteePage.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(home.id);
  const inviteeSidebar = inviteePage.locator("aside").first();
  await expect(inviteeSidebar.getByText("Home", { exact: true })).toBeVisible();
  await inviteePage.reload();
  await expect
    .poll(() => inviteePage.evaluate(() => localStorage.getItem("rakazo:space-id")))
    .toBe(home.id);
  await expect(inviteeSidebar.getByText("Home", { exact: true })).toBeVisible();

  await inviteeSidebar.getByRole("button", { name: "Actions for Home" }).click();
  await inviteePage.getByRole("menuitem", { name: "Settings" }).click();
  const inviteeSettings = inviteePage.getByTestId("user-settings");
  await expect(inviteeSettings.getByText("Ada Owner")).toBeVisible();
  await expect(inviteeSettings.getByText("Bob Invitee")).toBeVisible();
  await expect(inviteeSettings.getByRole("button", { name: "Mời" })).toHaveCount(0);
  await expect(inviteeSettings.getByRole("button", { name: "Leave space" })).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-members-member");

  await inviteePage.goto(invitePath);
  await inviteePage.waitForURL(/\/app/);
  expect(acceptCalls).toBe(1);
  await expect(
    inviteePage.getByRole("heading", { name: "Liên kết mời này không còn hiệu lực." }),
  ).toHaveCount(0);
  await expect(inviteeSidebar.getByText("Home", { exact: true })).toBeVisible();

  await latePage.goto(invitePath);
  await latePage.waitForURL((url) => url.pathname === "/sign-in");
  await enterAccount(latePage, {
    email: lateEmail,
    name: "Late Invitee",
    password,
    invitePath,
  });
  await expect(
    latePage.getByRole("heading", { name: "Liên kết mời này không còn hiệu lực." }),
  ).toBeVisible();
  await captureScreenshot(latePage, testInfo, "space-invite-invalid");
  await latePage.getByRole("button", { name: "Open VNBot", exact: true }).click();
  await latePage.waitForURL((url) => url.pathname !== invitePath);
  await expect(latePage.getByText("Home", { exact: true })).toHaveCount(0);

  const denied = await inviteePage.request.post("/rpc/spaces/members/list", {
    headers: { "x-rakazo-space-id": privateSpace.id },
    data: { json: { spaceId: privateSpace.id } },
  });
  expect(denied.ok()).toBe(false);
  expect([401, 403, 404]).toContain(denied.status());
  await inviteePage.evaluate((id) => localStorage.setItem("rakazo:space-id", id), privateSpace.id);
  await inviteePage.goto("/app");
  await expect(
    inviteePage
      .getByRole("button", { name: "Actions for Home" })
      .or(inviteePage.getByRole("alert")),
  ).toBeVisible();
  await expect(inviteePage.getByText("Ada Secret", { exact: true })).toHaveCount(0);
  await expect(inviteePage.getByPlaceholder("Message Ada Secret")).toHaveCount(0);
  await inviteePage.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.id);
  await inviteePage.goto("/app");
  await expect(inviteeSidebar.getByRole("button", { name: "Actions for Home" })).toBeVisible();

  const familyRow = (page: Page) =>
    page.locator("aside").first().locator(`[data-roster-bot-id="${bot.id}"]`);
  await openBotInSpace(inviteePage, home.id, planner.id, "Planner");
  await openBotInSpace(ownerPage, home.id, bot.id, "Family");
  await send(ownerPage, "Can you plan dinner for Saturday?");
  await inviteePage.reload();
  await expect(familyRow(inviteePage)).toHaveAttribute("data-roster-unread", "true");
  await captureScreenshot(inviteePage, testInfo, "shared-unread-invitee");
  await ownerPage.bringToFront();
  await expect(familyRow(ownerPage)).not.toHaveAttribute("data-roster-unread", "true");

  await inviteePage.bringToFront();
  await openBotInSpace(inviteePage, home.id, bot.id, "Family");
  await expect(familyRow(inviteePage)).not.toHaveAttribute("data-roster-unread", "true");
  await send(inviteePage, "Make it vegetarian please");
  await expect(inviteePage.getByText("Ada Owner", { exact: true })).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "shared-thread-invitee");
  await ownerPage.reload();
  await expect(ownerPage.getByText("Bob Invitee", { exact: true })).toBeVisible();
  await captureScreenshot(ownerPage, testInfo, "shared-thread-owner");

  const group = await post("groups/create", {
    name: "Household",
    botIds: [bot.id, planner.id],
  });
  await inviteePage.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.id);
  await inviteePage.goto(`/app/g/${group.id}`);
  await send(inviteePage, "@everyone what should we cook tonight?");
  await expect(inviteePage.getByTestId("message-bot-bubble")).toHaveCount(2, { timeout: 30_000 });
  await expect(inviteePage.getByText("Planner", { exact: true }).last()).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "shared-group-invitee");

  const membersUnknown: unknown = await rpc(ownerPage, "spaces/members/list", { spaceId: home.id });
  const members = SpaceMembersSchema.safeParse(membersUnknown);
  if (!members.success) throw new Error(members.error.message);
  const inviteeMember = members.data.members.find((member) => member.email === inviteeEmail);
  if (!inviteeMember) throw new Error("the invited account is missing from Home");
  const inviteeLabel = accountDisplay(inviteeMember, inviteeMember.email).label;
  await ownerSidebar.getByRole("button", { name: "Actions for Home" }).click();
  await ownerPage.getByRole("menuitem", { name: "Settings" }).click();
  await ownerSettings.getByRole("button", { name: `Actions for ${inviteeLabel}` }).click();
  await ownerPage.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await ownerPage
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await expect(ownerPage.getByRole("alertdialog")).toHaveCount(0);
  await expect(ownerSettings.getByText(inviteeLabel)).toHaveCount(0);

  const lost = await inviteePage.request.post("/rpc/spaces/members/list", {
    headers: { "x-rakazo-space-id": home.id },
    data: { json: { spaceId: home.id } },
  });
  expect(lost.ok()).toBe(false);
  expect([401, 403, 404]).toContain(lost.status());
  await inviteePage.goto("/app");
  await expect(inviteePage.getByRole("button", { name: "Actions for Home" })).toHaveCount(0);

  await owner.close();
  await invitee.close();
  await late.close();
});
