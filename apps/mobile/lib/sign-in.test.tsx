// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SignIn from "../app/sign-in";
import {
  loadSessionToken,
  passwordResetCapabilities,
  rpc,
  sendSignInCode,
  signIn,
  signInWithCode,
} from "./api";
import type { NativeActionButtonProps } from "./native-controls";
import { passkeysAvailable, signInWithPasskey } from "./passkey";

const route = vi.hoisted(() => ({ mode: "in", waiting: false, redirect: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const server = vi.hoisted(() => ({ base: "https://example.invalid", refocus: () => {} }));

vi.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => {
    route.redirect(href);
    return null;
  },
  useRouter: () => router,
  useLocalSearchParams: () => route,
  useFocusEffect: (effect: () => void) => {
    server.refocus = effect;
  },
}));
vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    KeyboardAvoidingView: Container,
    TouchableWithoutFeedback: Container,
    ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel?: string }) => (
      <div role="progressbar" aria-label={accessibilityLabel} />
    ),
    View: Container,
    ScrollView: Container,
    Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    TextInput: ({
      accessibilityLabel,
      placeholder,
      secureTextEntry,
      textContentType,
      autoComplete,
      keyboardType,
      maxLength,
      value,
      onChangeText,
      onSubmitEditing,
    }: {
      accessibilityLabel?: string;
      placeholder: string;
      secureTextEntry?: boolean;
      textContentType?: string;
      autoComplete?: string;
      keyboardType?: string;
      maxLength?: number;
      value?: string;
      onChangeText?: (value: string) => void;
      onSubmitEditing?: () => void;
    }) => (
      <input
        aria-label={accessibilityLabel ?? placeholder}
        type={secureTextEntry ? "password" : "text"}
        data-text-content-type={textContentType}
        autoComplete={autoComplete}
        inputMode={keyboardType === "number-pad" ? "numeric" : undefined}
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChangeText?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmitEditing?.();
        }}
      />
    ),
    Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    accessibilityLabel,
    prominence = "primary",
    onPress,
    disabled,
  }: NativeActionButtonProps) => (
    <button
      type="button"
      aria-label={accessibilityLabel}
      data-prominence={prominence}
      disabled={disabled}
      onClick={onPress}
    >
      {label}
    </button>
  ),
}));
vi.mock("./native", () => ({ useMobileTokens: () => tokensForAppearance("light") }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
}));
vi.mock("./api", () => ({
  currentApiBase: () => server.base,
  displayApiHost: () => "example.invalid",
  usesCustomApiBase: () => false,
  loadSessionToken: vi.fn().mockResolvedValue(null),
  passwordResetCapabilities: vi.fn(),
  requestPasswordReset: vi.fn(),
  rpc: vi.fn(),
  sendSignInCode: vi.fn(),
  signIn: vi.fn(),
  signInWithCode: vi.fn(),
  signUp: vi.fn(),
}));
vi.mock("./incoming-share", () => ({ hasIncomingShare: () => route.waiting }));
vi.mock("./sso", () => ({ continueWithSso: vi.fn() }));
vi.mock("./passkey", () => ({ passkeysAvailable: vi.fn(), signInWithPasskey: vi.fn() }));
vi.mock("./user-error", () => ({ credentialIssueText: vi.fn(), errorText: vi.fn() }));

const capabilities = {
  passwordAuth: true,
  passwordReset: true,
  emailCode: true,
  resetUrl: "https://example.invalid/reset-password",
  sso: { name: "Example", availability: "available" as const },
};
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  route.mode = "in";
  route.waiting = false;
  server.base = "https://example.invalid";
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(passwordResetCapabilities).mockResolvedValue(capabilities);
  vi.mocked(passkeysAvailable).mockReset().mockResolvedValue(false);
  vi.mocked(signInWithPasskey).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<SignIn />));
}
function ssoButtons() {
  return [...host.querySelectorAll("button")].filter(
    (button) => button.textContent === "Continue with Example",
  );
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === label);
}
function input(label: string) {
  return host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}
async function type(field: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(label: string) {
  await act(async () => button(label)!.click());
}
it("offers only email and code, with no password controls", async () => {
  await render();
  expect(input("Email")).not.toBeNull();
  expect(input("Password")).toBeNull();
  expect(button("Forgot password?")).toBeUndefined();
  expect(button("Sign up")).toBeUndefined();
  expect(ssoButtons()).toHaveLength(1);
});

it("sends a code and signs in after six digits", async () => {
  vi.mocked(sendSignInCode).mockResolvedValue();
  vi.mocked(signInWithCode).mockResolvedValue();
  vi.mocked(rpc).mockResolvedValue({ needsSignupSurvey: false } as never);
  await render();
  await type(input("Email")!, " ada@example.test ");
  await press("Continue");
  expect(sendSignInCode).toHaveBeenCalledWith("ada@example.test");
  const code = input("Code")!;
  expect(code.dataset.textContentType).toBe("oneTimeCode");
  expect(code.autocomplete).toBe("one-time-code");
  await type(code, "12345");
  expect(signInWithCode).not.toHaveBeenCalled();
  await type(code, "123456");
  expect(signInWithCode).toHaveBeenCalledWith("ada@example.test", "123456", "ada");
  expect(signIn).not.toHaveBeenCalled();
  expect(router.replace).toHaveBeenCalledWith("/");
});

it("drops a code when the server changes", async () => {
  vi.mocked(sendSignInCode).mockResolvedValue();
  await render();
  await type(input("Email")!, "ada@example.test");
  await press("Continue");
  expect(input("Code")).not.toBeNull();
  server.base = "https://other.invalid";
  await act(async () => server.refocus());
  expect(input("Code")).toBeNull();
});

it("shows SSO when the server has no email code", async () => {
  vi.mocked(passwordResetCapabilities).mockResolvedValue({ ...capabilities, emailCode: false });
  await render();
  expect(input("Email")).toBeNull();
  expect(ssoButtons()).toHaveLength(1);
  expect(ssoButtons()[0]!.dataset.prominence).toBe("primary");
});

it("returns an existing session to a pending share", async () => {
  route.waiting = true;
  vi.mocked(loadSessionToken).mockResolvedValueOnce("session-token");
  await render();
  expect(route.redirect).toHaveBeenCalledWith("/share");
});
