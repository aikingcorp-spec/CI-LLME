import { Trans, useLingui } from "@lingui/react/macro";
import { EMAIL_NOT_INVITED } from "@rakazo/contracts";
import {
  credentialIssue,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  signupRequiresEmailVerification,
  suggestEmailCorrection,
} from "@rakazo/core";
import { Button, Input, InputOTP, InputOTPGroup, InputOTPSlot, Label } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { PasskeySignIn } from "../components/PasskeySignIn";
import { VnbotWordmark } from "../components/VnbotWordmark";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { desktopBridge } from "../lib/desktop";
import { getActiveUiLocale } from "../lib/i18n";
import { clearSpaceSelection } from "../lib/rpc";
import { newAccountDestination, signInNext } from "../lib/sign-in-next";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText, credentialIssueText } from "../lib/user-error";
import { VNBOT_COMMUNITY_URL, VNBOT_CONTACT_URL } from "../lib/vnbot-links";
import { WindowChrome } from "./WindowChrome";

type AuthMode = "in" | "up" | "forgot";

// off-scale: 16px below md stops iOS Safari zooming into a focused field.
const fieldClass = "mt-2 h-12 rounded-xl bg-muted px-4 text-[16px]/6";
const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;
const linkClass =
  "font-medium text-link underline underline-offset-4 hover:decoration-2 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
// off-scale: the approved 0.3.9 sign-in button uses 16px type.
export const submitClass = "mt-3 h-12 w-full rounded-xl text-[16px]/6";

function refusedInvite(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === EMAIL_NOT_INVITED
  );
}

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const [searchParams, setSearchParams] = useSearchParams();
  const next = signInNext(searchParams.get("next"));
  // Switching between sign-in and sign-up keeps where the person was going.
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [warnedEmail, setWarnedEmail] = useState<string | null>(null);
  const emailSuggestion = mode === "up" ? suggestEmailCorrection(email) : null;
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    if (!code) return null;
    return authErrorText({ code }, t`Could not continue`);
  });
  const [pending, setPending] = useState(false);
  const entering = useRef(false);
  const [resetSent, setResetSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const sent = resetSent || searchParams.get("verify") === "email";
  const [reset, setReset] = useState<AuthCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [resent, setResent] = useState(false);
  const useCode = Boolean(reset?.passwordAuth && reset.emailCode) && mode !== "forgot";
  const primaryCodeEntry = useCode;
  const codeMode = useCode;
  const codeStep = useCode && codeSent;
  const resendLabel = `${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, "0")}`;
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const title =
    sent || codeStep ? (
      <Trans>Check your email</Trans>
    ) : primaryCodeEntry ? (
      <Trans>Get started with VNBot</Trans>
    ) : mode === "in" ? (
      <Trans>Sign in to VNBot</Trans>
    ) : mode === "up" ? (
      <Trans>Create your VNBot</Trans>
    ) : (
      <Trans>Reset your password</Trans>
    );

  useEffect(() => {
    if (!codeStep || resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [codeStep, resendIn]);

  useEffect(() => {
    setReset(null);
    setCapabilityError(false);
    let active = true;
    void fetchAuthCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      // Do not abort on unmount: a guard redirect that bounces through this
      // page only mounts it for a render or two, and the cancelled fetch then
      // surfaces as a failed request. `active` drops the result; the request
      // keeps its own time bound.
      active = false;
    };
  }, [mode, capabilityAttempt]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reset?.passwordAuth) return;
    if (codeStep) {
      // An unfinished code would spend one of the code's three attempts.
      if (code.length === CODE_LENGTH) await verifyCode(code);
      return;
    }
    const issue = credentialIssue({
      email,
      password: mode === "forgot" || codeMode ? undefined : password,
    });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    if (emailSuggestion && warnedEmail !== email) {
      setWarnedEmail(email);
      setEmailBlurred(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(authErrorText(result.error, t`Could not send reset email`));
          return;
        }
        setResetSent(true);
        return;
      }
      const trimmedEmail = email.trim();
      if (codeMode) {
        const request = await authClient.emailOtp.sendVerificationOtp({
          email: trimmedEmail,
          type: "sign-in",
          // The send-code body schema drops unknown fields. Locale travels on this header.
          fetchOptions: {
            headers: { "x-rakazo-locale": getActiveUiLocale() === "vi" ? "vi" : "en" },
          },
        });
        if (request.error) {
          if (refusedInvite(request.error)) {
            setCodeSent(false);
            setCode("");
            setResent(false);
            setResendIn(0);
          }
          setError(authErrorText(request.error, t`Could not continue`));
          return;
        }
        setCode("");
        setCodeSent(true);
        setResendIn(RESEND_SECONDS);
        setResent(false);
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email: trimmedEmail,
              password,
              name: name || trimmedEmail.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email: trimmedEmail, password });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email", ...(next ? { next } : {}) });
        return;
      }
      enterApp();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  async function verifyCode(otp: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const trimmedEmail = email.trim();
      const result = await authClient.signIn.emailOtp({
        email: trimmedEmail,
        otp,
        // Only used when this creates the account.
        name: mode === "up" ? name || trimmedEmail.split("@")[0] || "User" : undefined,
      });
      if (result.error) {
        if (refusedInvite(result.error)) {
          setCodeSent(false);
          setResent(false);
          setResendIn(0);
        }
        setError(authErrorText(result.error, t`Could not continue`));
        setCode("");
        return;
      }
      enterApp();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  function enterApp() {
    clearSpaceSelection();
    // The routes move a signed-in user on once the session refetch lands. Navigating
    // first beats it, so the guards bounce through sign-in and the shell.
    entering.current = true;
    setPending(true);
  }

  async function resendCode() {
    if (pending || resendIn > 0) return;
    setPending(true);
    setError(null);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: email.trim(),
        type: "sign-in",
        // The send-code body schema drops unknown fields. Locale travels on this header.
        fetchOptions: {
          headers: { "x-rakazo-locale": getActiveUiLocale() === "vi" ? "vi" : "en" },
        },
      });
      if (result.error) {
        if (refusedInvite(result.error)) {
          setCodeSent(false);
          setCode("");
          setResent(false);
          setResendIn(0);
        }
        setError(authErrorText(result.error, t`Could not send code`));
        return;
      }
      setCode("");
      setResendIn(RESEND_SECONDS);
      setResent(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  function leaveCodeStep() {
    setCodeSent(false);
    setCode("");
    setError(null);
    setResent(false);
    setResendIn(0);
  }

  async function signInWithSso() {
    setError(null);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider: "oidc",
            newUserCallbackURL: callbackURL(newAccountDestination(next)),
            callbackURL: callbackURL(next ?? "/app"),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/integrations/setup", "/sign-in", ...(next ? [next] : [])],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch {
      setError(t`Could not continue`);
    }
  }

  if (!sent && !reset && !capabilityError) {
    return <div className="h-full bg-background" />;
  }

  return (
    <AuthFrame
      onSubmit={submit}
      title={title}
      notInvited={error !== null && error === authErrorText({ code: EMAIL_NOT_INVITED }, "")}
      subtitle={
        codeStep ? (
          <Trans>
            Nhập mã 6 số vừa được gửi tới{" "}
            <span className="font-medium text-foreground">{email.trim()}</span>. Mã có hiệu lực
            trong 10 phút.
          </Trans>
        ) : primaryCodeEntry ? (
          <Trans>Enter your email to get a 6-digit sign-in code.</Trans>
        ) : null
      }
    >
      {sent ? (
        <div className="w-full text-center">
          <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          {capabilityError ? (
            <div role="alert" className="w-full text-center">
              <p>
                <Trans>Could not load sign-in options</Trans>
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          {reset?.sso && !reset.passwordAuth && mode !== "forgot" ? (
            <Button
              type="button"
              disabled={pending}
              className={submitClass}
              onClick={() => void signInWithSso()}
            >
              <Trans>Continue with {reset.sso.name}</Trans>
            </Button>
          ) : null}
          {error && !reset?.passwordAuth ? (
            <p role="alert" className="mt-3 text-body text-destructive">
              {error}
            </p>
          ) : null}
          {reset?.passwordAuth ? (
            <>
              {mode === "up" && !codeStep && !primaryCodeEntry ? (
                <div className="mb-4 w-full">
                  <Label htmlFor="name" className="text-muted-foreground">
                    <Trans>Name</Trans>
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t`Your name`}
                    className={fieldClass}
                  />
                </div>
              ) : null}
              {codeStep ? (
                <div className="flex w-full justify-center">
                  <InputOTP
                    aria-label={t({ message: "Code", context: "email sign-in" })}
                    maxLength={CODE_LENGTH}
                    pattern={"^\\d+$"}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    disabled={pending}
                    value={code}
                    onChange={setCode}
                    onComplete={(value: string) => void verifyCode(value)}
                  >
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="size-12 text-heading3 first:rounded-l-xl last:rounded-r-xl"
                        />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              ) : (
                <div className="w-full">
                  <Label htmlFor="email" className="text-muted-foreground">
                    <Trans>Email</Trans>
                  </Label>
                  <Input
                    id="email"
                    name="email"
                    autoFocus={primaryCodeEntry}
                    autoComplete={mode === "in" ? "username webauthn" : "username"}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setEmailBlurred(false);
                    }}
                    onBlur={() => setEmailBlurred(true)}
                    placeholder={t`Your email address`}
                    type="email"
                    required
                    className={fieldClass}
                  />
                  {emailSuggestion && emailBlurred ? (
                    <p role="status" className="mt-2 text-body text-warning">
                      <Trans>
                        Did you mean{" "}
                        <button
                          type="button"
                          className="font-medium underline"
                          onClick={() => setEmail(emailSuggestion)}
                        >
                          {emailSuggestion}
                        </button>
                        ?
                      </Trans>
                    </p>
                  ) : null}
                </div>
              )}
              {mode !== "forgot" && !codeStep && !primaryCodeEntry ? (
                <div className="mt-4 w-full">
                  <Label htmlFor={passwordFieldId} className="text-muted-foreground">
                    <Trans>Password</Trans>
                  </Label>
                  <Input
                    id={passwordFieldId}
                    name="password"
                    autoComplete={mode === "in" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t`Password`}
                    type="password"
                    required={!useCode}
                    minLength={mode === "up" ? MIN_PASSWORD_LENGTH : undefined}
                    maxLength={MAX_PASSWORD_LENGTH}
                    className={fieldClass}
                  />
                  {mode === "in" && reset?.passwordReset ? (
                    <div className="mt-2 text-right text-body">
                      <Link to="/forgot-password" className="font-medium text-foreground">
                        <Trans>Forgot password?</Trans>
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="mt-3 w-full text-body text-destructive">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                size="lg"
                disabled={pending || (codeStep && code.length < CODE_LENGTH)}
                className={submitClass}
              >
                {pending ? (
                  <Trans>Working…</Trans>
                ) : codeMode && !codeStep ? (
                  <Trans>Send code</Trans>
                ) : codeMode ? (
                  <Trans>Continue</Trans>
                ) : mode === "in" ? (
                  <Trans>Sign in</Trans>
                ) : mode === "forgot" ? (
                  <Trans>Send reset link</Trans>
                ) : (
                  <Trans>Create account</Trans>
                )}
              </Button>
              {mode === "in" && !codeStep && !primaryCodeEntry ? (
                <PasskeySignIn
                  disabled={pending}
                  className={submitClass}
                  onSignedIn={enterApp}
                  onError={setError}
                />
              ) : null}
              {codeStep ? (
                <div className="mt-3 text-center text-body text-muted-foreground">
                  {resent ? (
                    <p role="status">
                      <Trans>Đã gửi mã mới. Mã cũ không dùng được nữa.</Trans>
                    </p>
                  ) : null}
                  {resendIn > 0 ? (
                    <p>
                      <Trans>Chưa nhận được mã? Gửi lại sau {resendLabel}</Trans>
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      className={`min-h-11 ${linkClass}`}
                      onClick={() => void resendCode()}
                    >
                      <Trans>Gửi lại mã</Trans>
                    </button>
                  )}
                </div>
              ) : null}
              {codeStep ? (
                <button
                  type="button"
                  disabled={pending}
                  className={`mt-6 min-h-11 ${linkClass}`}
                  onClick={leaveCodeStep}
                >
                  <Trans>Đổi email khác</Trans>
                </button>
              ) : null}
              {reset.sso && mode !== "forgot" && !codeStep ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={pending}
                  className="mt-3 text-muted-foreground"
                  onClick={() => void signInWithSso()}
                >
                  <Trans>Continue with {reset.sso.name}</Trans>
                </Button>
              ) : null}
              {codeStep || primaryCodeEntry ? null : (
                <p className="mt-8 text-muted-foreground">
                  {mode === "in" ? (
                    <>
                      <Trans>Don’t have an account?</Trans>{" "}
                      <Link to={`/sign-up${nextQuery}`} className="font-medium text-foreground">
                        <Trans>Sign up</Trans>
                      </Link>
                    </>
                  ) : mode === "up" ? (
                    <>
                      <Trans>Already have an account?</Trans>{" "}
                      <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
                        <Trans>Sign in</Trans>
                      </Link>
                    </>
                  ) : (
                    <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
                      <Trans>Back to sign in</Trans>
                    </Link>
                  )}
                </p>
              )}
            </>
          ) : null}
        </>
      )}
    </AuthFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not reset password`));
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-heading3">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-body text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

export function AuthFrame({
  title,
  subtitle,
  onSubmit,
  notInvited = false,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  /** The invite list refused the address: point the person to where approval happens. */
  notInvited?: boolean;
  children: React.ReactNode;
}) {
  const server = desktopBridge()?.server;
  return (
    <div className="relative flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground">
      <div className="app-drag absolute start-5 top-4">
        <WindowChrome />
      </div>
      {/* Outside the form: picking a language must never submit it. */}
      <LanguageSwitch className="absolute end-5 top-4 max-sm:end-3 max-sm:top-3" />
      <div className="flex w-[460px] max-w-full flex-col items-center">
        <form noValidate onSubmit={onSubmit} className="flex w-full flex-col items-center">
          <VnbotWordmark variant="wordmark" className="h-8 w-auto sm:h-9" />
          <h1
            aria-live="polite"
            className={
              // off-scale: the approved 0.3.9 title is 36px on desktop and 30px on phones.
              "mt-7 text-center text-[36px]/10 font-medium tracking-tight max-sm:text-[30px]/9"
            }
          >
            {title}
          </h1>
          {subtitle ? (
            <p className="mb-9 mt-3 text-center text-body text-pretty text-muted-foreground">
              {subtitle}
            </p>
          ) : (
            <div className="mb-9" />
          )}
          {children}
        </form>
        {notInvited ? (
          <Button
            variant="outline"
            className={submitClass}
            render={<a href={VNBOT_COMMUNITY_URL} target="_blank" rel="noopener noreferrer" />}
          >
            <Trans>VNBot community</Trans>
          </Button>
        ) : null}
        <p className="mt-8 flex gap-4 text-body text-muted-foreground">
          <a
            href={VNBOT_CONTACT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`max-md:inline-flex max-md:min-h-11 max-md:items-center ${linkClass}`}
          >
            <Trans>Contact</Trans>
          </a>
        </p>
        {server ? (
          <Button type="button" variant="text" size="sm" onClick={() => void server.change()}>
            <Trans>Change server</Trans>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
