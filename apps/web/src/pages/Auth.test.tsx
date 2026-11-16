// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cloneElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import * as localeModule from "../lib/i18n";
import { clearSpaceSelection } from "../lib/rpc";
import { AuthPage } from "./Auth";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant,
    size,
    render,
    ...props
  }: React.ComponentProps<"button"> & {
    variant?: string;
    size?: string;
    render?: React.ReactElement<{ children?: ReactNode }>;
  }) =>
    render ? (
      cloneElement(render, { "data-variant": variant ?? "default" } as never, children)
    ) : (
      <button data-variant={variant ?? "default"} data-size={size} {...props}>
        {children}
      </button>
    ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
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
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipContent: () => null,
  Label: ({ children, htmlFor, ...props }: React.ComponentProps<"label">) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
}));
vi.mock("../lib/auth-capabilities", () => ({ fetchAuthCapabilities: vi.fn() }));
vi.mock("../lib/auth", () => ({
  authClient: {
    signIn: { social: vi.fn(async () => ({})), email: vi.fn(), emailOtp: vi.fn() },
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
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete window.rakazoDesktop;
});
async function render(mode: "in" | "up" | "forgot" = "in", entry = "/") {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthPage mode={mode} />
      </MemoryRouter>,
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
  return [...host.querySelectorAll("button")].find((button) => button.textContent === text)!;
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.requestSubmit();
  });
}
it.each(["in", "up", "forgot"] as const)(
  "stays blank while capabilities load on %s",
  async (mode) => {
    vi.mocked(fetchAuthCapabilities).mockReturnValue(new Promise(() => undefined));
    await render(mode);
    expect(host.querySelector("input")).toBeNull();
    expect(host.textContent).toBe("");
    expect(host.querySelector("form")).toBeNull();
  },
);
it.each(["in", "up"] as const)("offers SSO and hides credentials on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render(mode);
  expect(host.textContent).toContain("Continue with Example");
  expect(host.querySelector("input")).toBeNull();
  const sso = button("Continue with Example");
  expect(sso.dataset.variant).toBe("default");
  expect(sso.className).toContain("w-full");
});
it("retries failed capabilities without exposing a password form", async () => {
  vi.mocked(fetchAuthCapabilities)
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(capabilities);
  await render();
  expect(host.textContent).toContain("Could not load sign-in options");
  expect(host.querySelector("input")).toBeNull();
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  await act(async () => retry.click());
  expect(fetchAuthCapabilities).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Continue with Example");
});
it.each(["in", "up"] as const)("puts quiet SSO below the primary action on %s", async (mode) => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render(mode);
  const email = host.querySelector('input[name="email"]')!;
  const password = host.querySelector('input[type="password"]')!;
  const submit = host.querySelector('button[type="submit"]')!;
  const sso = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Continue with Example",
  )!;
  for (const [first, second] of [
    [email, password],
    [password, submit],
    [submit, sso],
  ] as const) {
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(submit.getAttribute("data-variant")).toBe("default");
  expect(sso.dataset.variant).toBe("link");
  expect(sso.dataset.size).toBe("sm");
});

it("hides SSO in password recovery", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...capabilities, passwordAuth: true });
  await render("forgot");
  expect(host.textContent).not.toContain("Continue with Example");
});

it("selects a non-redirecting SSO request on desktop", async () => {
  vi.spyOn(window, "open").mockReturnValue({ close: vi.fn() } as unknown as Window);
  window.rakazoDesktop = {} as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockResolvedValue({
    data: null,
    error: { message: "Unavailable", status: 503, statusText: "Unavailable" },
  });
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(authClient.signIn.social).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "oidc", disableRedirect: true }),
  );
});

it("lets the desktop app change its server from sign in", async () => {
  const change = vi.fn(async () => undefined);
  window.rakazoDesktop = { server: { change } } as unknown as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render();
  const button = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Change server",
  )!;
  await act(async () => button.click());
  expect(change).toHaveBeenCalledOnce();
});

it("offers no server change in a browser", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  await render();
  expect(host.textContent).not.toContain("Change server");
});

it("keeps SSO available for retry while an authorization request is pending", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(capabilities);
  vi.mocked(authClient.signIn.social).mockReturnValue(new Promise(() => undefined));
  await render();
  const button = Array.from(host.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Continue with"),
  )!;
  await act(async () => button.click());
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(authClient.signIn.social).toHaveBeenCalledTimes(2);
});

const codeCapabilities: AuthCapabilities = {
  ...capabilities,
  sso: null,
  passwordAuth: true,
  emailCode: true,
};

it("signs in with an emailed code when the password is blank", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), " person@example.com ");
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Send code");
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    type: "sign-in",
    fetchOptions: { headers: { "x-rakazo-locale": "vi" } },
  });
  expect(host.querySelector("h1")!.textContent).toBe("Check your email");
  const code = host.querySelector('input[aria-label="Code"]')!;
  expect(code.getAttribute("autocomplete")).toBe("one-time-code");
  await enter(code, "123456");
  expect(authClient.signIn.emailOtp).toHaveBeenCalledWith({
    email: "person@example.com",
    otp: "123456",
    name: undefined,
  });
  // The session refetch moves a signed-in user on; until then the form stays busy.
  expect(clearSpaceSelection).toHaveBeenCalled();
  expect(button("Working…").disabled).toBe(true);
});

it("keeps an invite as the destination when switching to sign-in", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...codeCapabilities, emailCode: false });
  await render("up", `/?next=${encodeURIComponent("/invite/token-1")}`);
  expect(host.querySelector('a[href^="/sign-in"]')?.getAttribute("href")).toBe(
    "/sign-in?next=%2Finvite%2Ftoken-1",
  );
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

it("keeps the invite address when the person switches email during the code step", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/sign-in?next=${encodeURIComponent("/invite/token-1")}`]}>
        <AuthPage mode="in" />
        <Where />
      </MemoryRouter>,
    ),
  );
  const address = "/sign-in?next=%2Finvite%2Ftoken-1";
  expect(host.querySelector("[data-testid=where]")?.textContent).toBe(address);
  await enter(host.querySelector('input[name="email"]'), "ada@example.com");
  await submit();
  await act(async () => button("Đổi email khác").click());
  expect(host.querySelector("[data-testid=where]")?.textContent).toBe(address);
  expect(host.querySelector('input[name="email"]')).not.toBeNull();
});

it("creates an account from the email and keeps it when going back from the code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  vi.mocked(authClient.signIn.emailOtp)
    .mockResolvedValueOnce({
      data: null,
      error: { code: "INVALID_OTP", message: "Invalid OTP", status: 400, statusText: "" },
    } as never)
    .mockResolvedValueOnce({ data: {}, error: null } as never);
  await render("up");
  expect(host.querySelector('input[name="name"]')).toBeNull();
  await enter(host.querySelector('input[name="email"]'), "ada@example.com");
  await submit();
  await enter(host.querySelector('input[aria-label="Code"]'), "111111");
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Invalid code");
  await act(async () => button("Đổi email khác").click());
  expect(host.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(
    "ada@example.com",
  );
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(2);
  await enter(host.querySelector('input[aria-label="Code"]'), "222222");
  expect(authClient.signIn.emailOtp).toHaveBeenLastCalledWith({
    email: "ada@example.com",
    otp: "222222",
    name: "ada",
  });
  // The session refetch moves a signed-in user on; until then the form stays busy.
  expect(clearSpaceSelection).toHaveBeenCalled();
  expect(button("Working…").disabled).toBe(true);
});

it("sends the code on the first Continue but never submits an unfinished code", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "person@example.com");
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
  const continueButton = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(continueButton.disabled).toBe(true);
  await submit();
  await enter(host.querySelector('input[aria-label="Code"]'), "12345");
  expect(continueButton.disabled).toBe(true);
  await submit();
  expect(authClient.signIn.emailOtp).not.toHaveBeenCalled();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(1);
});

it("keeps password-only server compatibility without adding a method switch to the email flow", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...codeCapabilities, emailCode: false });
  vi.mocked(authClient.signIn.email).mockResolvedValue({ data: {}, error: null } as never);
  await render();
  const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(password.required).toBe(true);
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Sign in");
  expect(host.textContent).not.toContain("Use password");
  await enter(host.querySelector('input[name="email"]'), "person@example.com");
  await enter(password, "example-password");
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Sign in");
  await submit();
  expect(authClient.signIn.email).toHaveBeenCalledWith({
    email: "person@example.com",
    password: "example-password",
  });
  expect(authClient.emailOtp.sendVerificationOtp).not.toHaveBeenCalled();
});

it("leaves the password form unchanged without email codes", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue({ ...codeCapabilities, emailCode: false });
  await render();
  expect(host.querySelector('input[type="password"]')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.required).toBe(true);
  expect(host.querySelector('button[type="submit"]')!.textContent).toBe("Sign in");
});

it("keeps desktop email entry and verification in the app", async () => {
  window.rakazoDesktop = {} as NonNullable<Window["rakazoDesktop"]>;
  const external = vi.spyOn(window, "open");
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({} as never);
  await render();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await enter(host.querySelector('input[name="email"]'), "test@example.test");
  await submit();
  expect(host.querySelector("[data-otp]")).not.toBeNull();
  expect(external).not.toHaveBeenCalled();
  expect(authClient.signIn.social).not.toHaveBeenCalled();
});

it("resends the code to the same mailbox and clears the unfinished code", async () => {
  vi.useFakeTimers();
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({} as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "test@example.test");
  await submit();
  await enter(host.querySelector("[data-otp]"), "123");
  expect(button("Gửi lại mã")).toBeUndefined();
  expect(host.textContent).toContain("1:00");
  for (let second = 0; second < 60; second += 1) {
    await act(async () => vi.advanceTimersByTime(1000));
  }
  await act(async () => button("Gửi lại mã").click());
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledTimes(2);
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenLastCalledWith({
    email: "test@example.test",
    type: "sign-in",
    fetchOptions: { headers: { "x-rakazo-locale": "vi" } },
  });
  expect(host.querySelector<HTMLInputElement>("[data-otp]")?.value).toBe("");
  expect(clearSpaceSelection).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("shows only email and code in the desktop login flow", async () => {
  window.rakazoDesktop = {} as NonNullable<Window["rakazoDesktop"]>;
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  await render();
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(
    [...host.querySelectorAll("button")].some(
      (node) => node.textContent === "Other sign-in options",
    ),
  ).toBe(false);
});

it("sends the selected English locale with the code request", async () => {
  vi.spyOn(localeModule, "getActiveUiLocale").mockReturnValue("en");
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: { success: true },
    error: null,
  } as never);
  await render();
  await enter(host.querySelector('input[name="email"]'), "person@example.test");
  await submit();
  expect(authClient.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "person@example.test",
    type: "sign-in",
    fetchOptions: { headers: { "x-rakazo-locale": "en" } },
  });
});

it("says the address is not approved and points to the community when the invite list refuses it", async () => {
  vi.mocked(fetchAuthCapabilities).mockResolvedValue(codeCapabilities);
  await render("in", "/sign-in?error=EMAIL_NOT_INVITED");
  expect(host.textContent).toContain("This email is not approved for VNBot yet");
  expect(host.querySelector('a[href="https://aikingx.com/lien-he/"]')).not.toBeNull();
  expect(host.querySelector('a[href^="https://zalo.me/"]')?.textContent).toBe("VNBot community");
  vi.mocked(authClient.emailOtp.sendVerificationOtp).mockResolvedValue({
    data: null,
    error: { code: "EMAIL_NOT_INVITED", message: "This email is not invited yet", status: 403 },
  } as never);
  await enter(host.querySelector('input[name="email"]'), "ada@example.test");
  await submit();
  expect(host.querySelector("h1")!.textContent).not.toBe("Check your email");
  expect(host.textContent).toContain("This email is not approved for VNBot yet");
  expect(clearSpaceSelection).not.toHaveBeenCalled();
});
