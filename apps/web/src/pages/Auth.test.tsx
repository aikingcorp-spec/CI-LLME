// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { getActiveUiLocale } from "../lib/i18n";
import { clearSpaceSelection } from "../lib/rpc";
import { SIGN_IN_PROGRESS_KEY } from "../lib/sign-in-progress";
import { EMAIL_NOT_INVITED } from "../lib/user-error";
import { VNBOT_CONTACT_URL } from "../lib/vnbot-links";
import { AuthPage } from "./Auth";
import { WelcomePage } from "./Welcome";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web/components/ui/input-otp", () => ({
  InputOTP: ({
    maxLength,
    onChange,
    onComplete,
    children: _children,
    ...props
  }: Omit<React.ComponentProps<"input">, "onChange"> & {
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
  }) => (
    <input
      {...props}
      data-otp=""
      onChange={(event) => {
        onChange(event.target.value);
        if (event.target.value.length === maxLength) onComplete?.(event.target.value);
      }}
    />
  ),
  InputOTPGroup: () => null,
  InputOTPSlot: () => null,
}));
vi.mock("../components/VnbotWordmark", () => ({
  VnbotWordmark: () => <img alt="VNBot" />,
}));
vi.mock("../components/LanguageSwitch", () => ({
  LanguageSwitch: () => <button type="button" data-testid="language-switch" />,
}));
vi.mock("../components/PasskeySignIn", () => ({
  PasskeySignIn: () => (
    <p>
      Already set up a passkey? <button type="button">Sign in with a passkey</button>
    </p>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { social: vi.fn(async () => ({})), emailOtp: vi.fn() },
    emailOtp: { sendVerificationOtp: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));

const capabilities: AuthCapabilities = {
  passwordAuth: false,
  sso: { name: "Example", availability: "unavailable" },
  passwordReset: false,
  resetUrl: null,
};
const emailCapabilities: AuthCapabilities = {
  ...capabilities,
  sso: null,
  passwordAuth: true,
  emailCode: true,
};

i18n.load("en", {});
i18n.activate("en");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.rakazoDesktop;
});
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter>
          <AuthPage />
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
}
async function enter(input: Element | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === text)!;
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}

it("stays blank while capabilities load", async () => {
  vi.mocked(fetchAuthCapabilities).mockReturnValue(new Promise(() => undefined));
  await render();
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toBe("");
  expect(host.querySelector("form")).toBeNull();
});

it("offers SSO and hides the email form when passwords and codes are off", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render();
  expect(host.textContent).toContain("Continue with Example");
  expect(host.querySelector("input")).toBeNull();
  const sso = [...host.querySelectorAll("button")].find((item) =>
    item.textContent?.includes("Continue with Example"),
  )!;
  expect(sso.className).toContain("bg-primary");
  expect(sso.className).toContain("w-full");
});

it("retries failed capabilities without exposing a password form", async () => {
  vi.mocked(fetchAuthCapabilities)
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(capabilities);
  await render();
  expect(host.textContent).toContain("Could not load sign-in options");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await act(async () => button("Retry").click());
  expect(fetchAuthCapabilities).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Continue with Example");
});

it("puts quiet SSO below the email code action and has no password field", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({
    ...emailCapabilities,
    sso: capabilities.sso,
  });
  await render();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  const email = host.querySelector('input[name="email"]')!;
  const submitButton = host.querySelector('button[type="submit"]')!;
  const sso = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "Continue with Example",
  )!;
  expect(
    email.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(submitButton.compareDocumentPosition(sso) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(submitButton.textContent).toBe("Send code");
  expect(sso.className).toContain("underline-offset-4");
});

it("sends a code, masks it, and signs in with a name taken from the email", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  expect(host.querySelector("h1")!.textContent).toBe("Get started with VNBot");
  expect(document.activeElement).toBe(host.querySelector('input[name="email"]'));
  await enter(host.querySelector('input[name="email"]'), " person@example.com ");
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    type: "sign-in",
    fetchOptions: {
      headers: { "x-rakazo-locale": getActiveUiLocale() === "vi" ? "vi" : "en" },
    },
  });
  expect(host.querySelector("h1")!.textContent).toBe("Check your email");
  const code = host.querySelector('input[aria-label="6-digit sign-in code"]')!;
  expect(document.activeElement).toBe(code);
  expect(code.getAttribute("autocomplete")).toBe("one-time-code");
  await enter(code, "123456");
  expect(host.textContent).not.toContain("123456");
  expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    otp: "123456",
    name: "person",
  });
  expect(clearSpaceSelection).toHaveBeenCalled();
  expect(button("Verifying…").disabled).toBe(true);
});

it("shows the not-invited panel for EMAIL_NOT_INVITED and keeps the email", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: null,
    error: {
      code: EMAIL_NOT_INVITED,
      message: "This email is not invited yet",
      status: 403,
      statusText: "",
    },
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "mai@vnbot.vn");
  await submit();
  const status = host.querySelector('[role="status"]')!;
  expect(status.textContent).toContain("VNBot is in limited preview");
  expect(status.textContent).toContain("mai@vnbot.vn");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("h1")!.textContent).toBe("Get started with VNBot");
  expect(host.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe("mai@vnbot.vn");
  const contact = host.querySelector<HTMLAnchorElement>(`a[href="${VNBOT_CONTACT_URL}"]`)!;
  expect(contact).not.toBeNull();
  expect(contact.target).toBe("_blank");
  expect(contact.rel).toBe("noopener noreferrer");
  expect(contact.className).toContain("underline");
  expect(contact.getAttribute("aria-label")).toBe("Get in touch (opens in new tab)");
  expect(contact.textContent).toBe("Get in touch");
  await enter(host.querySelector('input[name="email"]'), "other@vnbot.vn");
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("returns focus to the code input after a wrong code is rejected", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  let rejectCode!: (result: never) => void;
  vi.mocked(authClient.signIn.emailOtp).mockImplementation(
    () =>
      new Promise((resolve) => {
        rejectCode = resolve;
      }),
  );
  await render();
  await enter(host.querySelector('input[name="email"]'), "ada@example.com");
  await submit();
  const code = host.querySelector<HTMLInputElement>('input[aria-label="6-digit sign-in code"]')!;
  await enter(code, "111111");
  host.querySelector<HTMLButtonElement>('[data-testid="language-switch"]')!.focus();
  expect(document.activeElement).not.toBe(code);
  await act(async () =>
    rejectCode({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid code", status: 400, statusText: "" },
    } as never),
  );
  expect(code.disabled).toBe(false);
  expect(code.value).toBe("");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(document.activeElement).toBe(code);
});

it("rejects a bad code without leaving the digits on the page, and offers a new code when it expires", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({
    data: null,
    error: { code: "OTP_EXPIRED", message: "expired", status: 400, statusText: "" },
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "ada@example.com");
  await submit();
  await enter(host.querySelector('input[aria-label="6-digit sign-in code"]'), "111111");
  expect(host.textContent).not.toContain("111111");
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("This code has expired");
  expect(button("Send a new code")).toBeTruthy();
  await act(async () => button("Use a different email").click());
  expect(host.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(
    "ada@example.com",
  );
  expect(document.activeElement).toBe(host.querySelector('input[name="email"]'));
});

describe("focus across real browser navigation", () => {
  const emailInput = () => host.querySelector<HTMLInputElement>('input[name="email"]');
  const codeInput = () => host.querySelector('input[aria-label="6-digit sign-in code"]');

  // The routes App.tsx declares for a signed-out visitor, on the router main.tsx uses.
  async function renderFromLanding() {
    window.history.replaceState(null, "", "/");
    await act(async () =>
      root.render(
        <I18nProvider i18n={i18n}>
          <BrowserRouter useTransitions={false}>
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/sign-in" element={<AuthPage key="in" />} />
            </Routes>
          </BrowserRouter>
        </I18nProvider>,
      ),
    );
  }
  async function followSignInLink() {
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!.click());
  }
  async function traverse(delta: number) {
    await act(async () => {
      const landed = new Promise((resolve) =>
        window.addEventListener("popstate", resolve, { once: true }),
      );
      window.history.go(delta);
      await landed;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
    vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
      data: { success: true },
      error: null,
    } as never);
  });

  it("focuses email after following the landing page's sign-in link", async () => {
    await renderFromLanding();
    expect(emailInput()).toBeNull();
    await followSignInLink();
    expect(window.location.pathname).toBe("/sign-in");
    expect(document.activeElement).toBe(emailInput());
  });

  it("focuses email again after going back to the landing page and forward", async () => {
    await renderFromLanding();
    await followSignInLink();
    await traverse(-1);
    expect(window.location.pathname).toBe("/");
    expect(emailInput()).toBeNull();
    await traverse(1);
    expect(window.location.pathname).toBe("/sign-in");
    expect(document.activeElement).toBe(emailInput());
  });

  it("returns from the code step to the prefilled, focused email step on back", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    expect(document.activeElement).toBe(codeInput());
    await traverse(-1);
    expect(window.location.pathname).toBe("/sign-in");
    expect(codeInput()).toBeNull();
    expect(emailInput()!.value).toBe("history@example.com");
    expect(document.activeElement).toBe(emailInput());
    expect(JSON.parse(sessionStorage.getItem(SIGN_IN_PROGRESS_KEY)!)).toMatchObject({
      email: "history@example.com",
      step: "email",
    });
  });

  it("restores and focuses the code step on forward, then email on a different email", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    expect(document.activeElement).toBe(codeInput());
    await traverse(-1);
    expect(window.location.pathname).toBe("/sign-in");
    expect(codeInput()).toBeNull();
    await traverse(1);
    expect(document.activeElement).toBe(codeInput());
    await act(async () => button("Use a different email").click());
    expect(document.activeElement).toBe(emailInput());
  });

  it("returns on forward to the email the code went to, not one edited since", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    await traverse(-1);
    await enter(emailInput(), "edited@example.com");
    await traverse(1);
    expect(host.textContent).toContain("history@example.com");
    expect(host.textContent).not.toContain("edited@example.com");
    expect(document.activeElement).toBe(codeInput());
  });

  it("leaves the page from the email step reached by back", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    await traverse(-1);
    await traverse(-1);
    expect(window.location.pathname).toBe("/");
    expect(emailInput()).toBeNull();
  });

  it("keeps back on the email step for a code step restored on a later visit", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    await traverse(-2);
    expect(window.location.pathname).toBe("/");
    await followSignInLink();
    expect(document.activeElement).toBe(codeInput());
    await traverse(-1);
    expect(window.location.pathname).toBe("/sign-in");
    expect(emailInput()!.value).toBe("history@example.com");
    expect(document.activeElement).toBe(emailInput());
  });

  it("keeps back on the email step after reloading the code step", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    // Simulate F5: a fresh mount on the same history entry and sessionStorage.
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(
        <I18nProvider i18n={i18n}>
          <BrowserRouter useTransitions={false}>
            <Routes>
              <Route path="/sign-in" element={<AuthPage key="in" />} />
            </Routes>
          </BrowserRouter>
        </I18nProvider>,
      ),
    );
    expect(document.activeElement).toBe(codeInput());
    await traverse(-1);
    expect(window.location.pathname).toBe("/sign-in");
    expect(emailInput()!.value).toBe("history@example.com");
    expect(document.activeElement).toBe(emailInput());
  });

  it("refocuses email when history moves within the mounted sign-in page", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    await act(async () => button("Use a different email").click());
    window.history.pushState(null, "", "/sign-in?next=%2Fapp");
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await traverse(-1);
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(emailInput());
  });

  it("refocuses the code field when history moves within the mounted sign-in page", async () => {
    await renderFromLanding();
    await followSignInLink();
    await enter(emailInput(), "history@example.com");
    await submit();
    window.history.pushState(null, "", "/sign-in?next=%2Fapp");
    (document.activeElement as HTMLElement).blur();
    await traverse(-1);
    expect(document.activeElement).toBe(codeInput());
  });
});

it("does not submit an unfinished code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "person@example.com");
  await submit();
  const continueButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(continueButton.disabled).toBe(true);
  await enter(host.querySelector('input[aria-label="6-digit sign-in code"]'), "12345");
  expect(continueButton.disabled).toBe(true);
  await submit();
  expect(authClient.signIn.emailOtp).not.toHaveBeenCalled();
});

it("asks for a valid email before sending a code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  await render();
  await enter(host.querySelector('input[name="email"]'), "not-an-email");
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Enter a valid email address.");
});

it("marks an empty or bad email invalid and points it at the error", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  await render();
  const input = () => host.querySelector<HTMLInputElement>('input[name="email"]')!;
  expect(input().hasAttribute("aria-invalid")).toBe(false);
  await submit();
  expect(input().getAttribute("aria-invalid")).toBe("true");
  const errorId = input().getAttribute("aria-describedby")!;
  expect(host.querySelector(`#${errorId}`)!.getAttribute("role")).toBe("alert");
  await enter(input(), "a");
  expect(input().hasAttribute("aria-invalid")).toBe(false);
  expect(input().hasAttribute("aria-describedby")).toBe(false);
});

it("renders the language switch outside the form", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  await render();
  const language = host.querySelector('[data-testid="language-switch"]')!;
  expect(language).not.toBeNull();
  expect(host.querySelector("form")!.contains(language)).toBe(false);
});

it("restores the code step and email after a reload, and forgets them on sign-in", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "lan@vnbot.vn");
  await submit();
  expect(JSON.parse(sessionStorage.getItem(SIGN_IN_PROGRESS_KEY)!)).toMatchObject({
    email: "lan@vnbot.vn",
    step: "code",
  });
  // Simulate F5: a fresh mount reads the same tab's sessionStorage.
  await act(async () => root.unmount());
  root = createRoot(host);
  await render();
  expect(host.querySelector("h1")!.textContent).toBe("Check your email");
  expect(host.textContent).toContain("lan@vnbot.vn");
  expect(host.textContent).not.toContain("Resend code");
  await enter(host.querySelector('input[aria-label="6-digit sign-in code"]'), "123456");
  expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
    email: "lan@vnbot.vn",
    otp: "123456",
    name: "lan",
  });
  expect(sessionStorage.getItem(SIGN_IN_PROGRESS_KEY)).toBeNull();
});

it("shows the not-invited state for ?error=EMAIL_NOT_INVITED (OIDC callback / revoked session)", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  sessionStorage.setItem(
    "vnbot.signIn",
    JSON.stringify({ email: "old@vnbot.vn", step: "code", sentAt: Date.now() }),
  );
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/sign-in?error=EMAIL_NOT_INVITED"]}>
          <AuthPage />
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
  const status = host.querySelector('[role="status"]')!;
  expect(status.textContent).toContain("VNBot is in limited preview");
  expect(status.textContent).toContain("Right now, only invited emails can sign in.");
  expect(status.textContent).not.toContain("isn't on");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('input[name="email"]')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe("");
  expect(sessionStorage.getItem("vnbot.signIn")).toBeNull();
  expect(host.querySelector(`a[href="${VNBOT_CONTACT_URL}"]`)).not.toBeNull();
});

it("shows the link-SSO-from-Settings copy for ?error=ACCOUNT_NOT_LINKED (SSO callback)", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/sign-in?error=ACCOUNT_NOT_LINKED"]}>
          <AuthPage />
        </MemoryRouter>
      </I18nProvider>,
    ),
  );
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(
    "This email already has an account. Sign in with an email code, then link SSO in Settings.",
  );
  expect(host.querySelector('input[name="email"]')).not.toBeNull();
});

it("keeps passkey sign-in without account creation promises and links the legal pages", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(emailCapabilities);
  await render();
  expect(host.textContent).toContain("Enter your email to get a 6-digit sign-in code.");
  expect(host.textContent).not.toContain("create one for you");
  expect(host.textContent).toContain("Sign in with a passkey");
  for (const [name, href] of [
    ["Terms", "https://vnbot.run/dieu-khoan"],
    ["Privacy", "https://vnbot.run/quyen-rieng-tu"],
    ["Contact", VNBOT_CONTACT_URL],
  ]) {
    const link = host.querySelector(`a[href="${href}"]`);
    expect(link?.textContent).toBe(name);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  }
});
