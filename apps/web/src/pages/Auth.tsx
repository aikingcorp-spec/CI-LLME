import { Trans, useLingui } from "@lingui/react/macro";
import { credentialIssue } from "@rakazo/core";
import { buttonVariants } from "@rakazo/ui-web/components/ui/button-variants";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@rakazo/ui-web/components/ui/input-otp";
import { inputClass } from "@rakazo/ui-web/components/ui/input-variants";
import { Label } from "@rakazo/ui-web/components/ui/label";
import { cn } from "@rakazo/ui-web/lib/utils";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { LanguageSwitch } from "../components/LanguageSwitch";
import { PasskeySignIn } from "../components/PasskeySignIn";
import { VnbotWordmark } from "../components/VnbotWordmark";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { getActiveUiLocale } from "../lib/i18n";
import { clearSpaceSelection } from "../lib/rpc";
import {
  clearSignInProgress,
  readSignInProgress,
  resendSecondsLeft,
  writeSignInProgress,
} from "../lib/sign-in-progress";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorCode, authErrorText, EMAIL_NOT_INVITED } from "../lib/user-error";
import { VNBOT_CONTACT_URL, VNBOT_PRIVACY_URL, VNBOT_TERMS_URL } from "../lib/vnbot-links";

const fieldClass = "mt-2 h-12 rounded-xl px-4 text-base md:text-base";
const CODE_LENGTH = 6;
const RESEND_SECONDS = 60;
export const submitClass = "mt-3 h-12 w-full rounded-xl text-base";
const EMAIL_ERROR_ID = "auth-email-error";
const linkClass =
  "font-medium text-link underline underline-offset-4 hover:decoration-2 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

type Step = "email" | "code";
/** History state of the code step's entry, so Back lands on email and Forward can return. */
type CodeEntry = { signInCode: { email: string; sentAt: number } };

function codeEntryOf(state: unknown): CodeEntry["signInCode"] | null {
  return (state as Partial<CodeEntry> | null)?.signInCode ?? null;
}

function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<"button"> &
  Pick<NonNullable<Parameters<typeof buttonVariants>[0]>, "variant" | "size">) {
  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

function formatResend(seconds: number): string {
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}:${String(rest).padStart(2, "0")}`;
}

export function AuthPage() {
  const { t } = useLingui();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  // F5 on the code step lands back on it (same tab only; see lib/sign-in-progress).
  // ?error=EMAIL_NOT_INVITED (OIDC callback 302 or a revoked session's 401) always lands on the
  // email step with the not-invited state; a stale code step from this tab is dropped.
  const [notInvitedFromUrl] = useState(() => searchParams.get("error") === EMAIL_NOT_INVITED);
  const [restored] = useState(() => {
    if (notInvitedFromUrl) {
      clearSignInProgress();
      return null;
    }
    return readSignInProgress();
  });
  const [email, setEmail] = useState(restored?.email ?? "");
  const [step, setStep] = useState<Step>(restored?.step ?? "email");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [notInvited, setNotInvited] = useState(notInvitedFromUrl);
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    if (!code || code === EMAIL_NOT_INVITED) return null;
    return authErrorText({ code }, t`Could not continue`);
  });
  const [pending, setPending] = useState(false);
  const entering = useRef(false);
  const [reset, setReset] = useState<AuthCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [code, setCode] = useState("");
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [needsNewCode, setNeedsNewCode] = useState(false);
  const [resendIn, setResendIn] = useState(() =>
    restored?.step === "code" ? resendSecondsLeft(restored.sentAt, RESEND_SECONDS) : 0,
  );
  const [resent, setResent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const seenEntry = useRef(location.key);
  const entryAdded = useRef(false);

  useEffect(() => {
    (step === "email" ? emailRef : codeRef).current?.focus();
  }, [reset, step]);

  useEffect(() => {
    if (codeInvalid && !pending) codeRef.current?.focus();
  }, [codeInvalid, pending]);

  // A code step restored without its own entry (a new visit to /sign-in in this tab) still gets
  // one, so Back lands on the email step here too.
  useEffect(() => {
    if (entryAdded.current || restored?.step !== "code" || codeEntryOf(location.state)) return;
    entryAdded.current = true;
    pushCodeEntry({ email: restored.email, sentAt: restored.sentAt ?? Date.now() }, false);
  }, []);

  // Back and Forward within the mounted page. On mount, sessionStorage decides instead: an old
  // entry must not revive a sign-in that has finished.
  useEffect(() => {
    if (seenEntry.current === location.key) return;
    seenEntry.current = location.key;
    const entry = codeEntryOf(location.state);
    if (entry && step === "email") returnToCodeStep(entry);
    if (!entry && step === "code") showEmailStep();
  }, [location.key]);

  useEffect(() => {
    const focusCurrentStep = () => {
      window.setTimeout(() => {
        (step === "email" ? emailRef : codeRef).current?.focus();
      }, 0);
    };
    window.addEventListener("popstate", focusCurrentStep);
    return () => window.removeEventListener("popstate", focusCurrentStep);
  }, [step]);

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
      active = false;
    };
  }, [capabilityAttempt]);

  useEffect(() => {
    if (step !== "code" || resendIn <= 0) return;
    const timer = window.setTimeout(() => {
      setResendIn((seconds) => {
        if (seconds <= 1) setResent(false);
        return Math.max(0, seconds - 1);
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [step, resendIn]);

  const ssoOnly = Boolean(reset?.sso && !reset.passwordAuth && !reset.emailCode);
  const trimmedEmail = email.trim();
  const resendLabel = formatResend(resendIn);

  function onEmailChange(value: string) {
    setEmail(value);
    setEmailInvalid(false);
    setNotInvited(false);
    setError(null);
  }

  async function sendCode(isResend: boolean) {
    if (credentialIssue({ email })) {
      setError(t`Enter a valid email address.`);
      setEmailInvalid(true);
      return;
    }
    setPending(true);
    setError(null);
    setNotInvited(false);
    try {
      const request = await authClient.emailOtp.sendVerificationOtp({
        email: trimmedEmail,
        type: "sign-in",
        // The send-code body schema drops unknown fields. Locale travels on this header.
        fetchOptions: {
          headers: {
            "x-rakazo-locale": getActiveUiLocale() === "vi" ? "vi" : "en",
          },
        },
      });
      if (request.error) {
        if (request.error?.code === EMAIL_NOT_INVITED) {
          setNotInvited(true);
          setStep("email");
          dropCodeEntry();
          return;
        }
        setError(authErrorText(request.error, t`Could not continue`));
        return;
      }
      setCode("");
      setCodeInvalid(false);
      setNeedsNewCode(false);
      setResendIn(RESEND_SECONDS);
      setResent(isResend);
      setStep("code");
      const sentAt = Date.now();
      writeSignInProgress({ email: trimmedEmail, step: "code", sentAt });
      pushCodeEntry({ email: trimmedEmail, sentAt }, isResend);
    } catch {
      setError(t`Couldn't reach the server. Try again.`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  async function verifyCode(otp: string) {
    if (pending || needsNewCode) return;
    setPending(true);
    setError(null);
    setCodeInvalid(false);
    try {
      const result = await authClient.signIn.emailOtp({
        email: trimmedEmail,
        otp,
        name: trimmedEmail.split("@")[0] || "User",
      });
      if (result.error) {
        const codeName = authErrorCode(result.error);
        if (codeName === EMAIL_NOT_INVITED) {
          setNotInvited(true);
          writeSignInProgress({ email: trimmedEmail, step: "email" });
          setStep("email");
          setCode("");
          dropCodeEntry();
          return;
        }
        setError(authErrorText(result.error, t`Could not continue`));
        setCode("");
        setCodeInvalid(true);
        if (codeName === "OTP_EXPIRED" || codeName === "TOO_MANY_ATTEMPTS") setNeedsNewCode(true);
        return;
      }
      enterApp();
    } catch {
      setError(t`Couldn't reach the server. Try again.`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  function enterApp() {
    clearSignInProgress();
    clearSpaceSelection();
    entering.current = true;
    setPending(true);
  }

  function pushCodeEntry(signInCode: CodeEntry["signInCode"], replace: boolean) {
    navigate(location, { replace, state: { signInCode } satisfies CodeEntry });
  }

  function dropCodeEntry() {
    if (codeEntryOf(location.state)) navigate(location, { replace: true });
  }

  function returnToCodeStep({ email: sentTo, sentAt }: CodeEntry["signInCode"]) {
    writeSignInProgress({ email: sentTo, step: "code", sentAt });
    setEmail(sentTo);
    setStep("code");
    setCode("");
    setError(null);
    setEmailInvalid(false);
    setNotInvited(false);
    setResendIn(resendSecondsLeft(sentAt, RESEND_SECONDS));
  }

  function showEmailStep() {
    writeSignInProgress({ email: trimmedEmail, step: "email" });
    setStep("email");
    setCode("");
    setError(null);
    setCodeInvalid(false);
    setNeedsNewCode(false);
    setResent(false);
  }

  function chooseDifferentEmail() {
    showEmailStep();
    dropCodeEntry();
  }

  async function signInWithSso() {
    setError(null);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider: "oidc",
            newUserCallbackURL: callbackURL("/onboarding"),
            callbackURL: callbackURL(
              searchParams.get("next") === "/integrations/setup" ? "/integrations/setup" : "/app",
            ),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/integrations/setup", "/sign-in"],
      );
      if (result.error) {
        if (authErrorCode(result.error) === EMAIL_NOT_INVITED) {
          setNotInvited(true);
          if (ssoOnly) setError(authErrorText(result.error, t`Could not continue`));
          return;
        }
        setError(authErrorText(result.error, t`Could not continue`));
      }
    } catch {
      setError(t`Could not continue`);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (ssoOnly || !reset) return;
    if (step === "code") {
      if (needsNewCode) {
        await sendCode(true);
        return;
      }
      if (code.length === CODE_LENGTH) await verifyCode(code);
      return;
    }
    await sendCode(false);
  }

  if (!reset && !capabilityError) {
    return <div className="h-full bg-background" />;
  }

  const title =
    step === "code" ? <Trans>Check your email</Trans> : <Trans>Get started with VNBot</Trans>;
  const subtitle =
    step === "code" ? (
      <Trans>
        Enter the 6-digit code we sent to{" "}
        <span className="font-medium text-foreground">{trimmedEmail}</span>. It expires in 10
        minutes.
      </Trans>
    ) : (
      <Trans>Enter your email to get a 6-digit sign-in code.</Trans>
    );

  return (
    <AuthFrame onSubmit={submit} title={title} subtitle={ssoOnly ? null : subtitle}>
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
      {ssoOnly && reset?.sso ? (
        <Button
          type="button"
          disabled={pending}
          className={submitClass}
          onClick={() => void signInWithSso()}
        >
          <Trans>Continue with {reset.sso.name}</Trans>
        </Button>
      ) : null}
      {error && ssoOnly ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!ssoOnly && reset ? (
        <>
          {step === "code" ? (
            <div className="flex w-full justify-center">
              <InputOTP
                aria-label={t`6-digit sign-in code`}
                aria-invalid={codeInvalid || undefined}
                maxLength={CODE_LENGTH}
                pattern={"^\\d+$"}
                inputMode="numeric"
                autoComplete="one-time-code"
                ref={codeRef}
                disabled={pending}
                value={code}
                onChange={(value) => {
                  setCode(value);
                  setCodeInvalid(false);
                }}
                onComplete={(value: string) => void verifyCode(value)}
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <InputOTPSlot
                      key={index}
                      index={index}
                      mask
                      aria-invalid={codeInvalid || undefined}
                      className="size-12 border-foreground/60 text-lg first:rounded-l-xl last:rounded-r-xl"
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
              <input
                id="email"
                name="email"
                ref={emailRef}
                autoComplete="username webauthn"
                value={email}
                onChange={(event) => onEmailChange(event.target.value)}
                placeholder={t`Your email address`}
                type="email"
                required
                disabled={pending}
                aria-invalid={emailInvalid || undefined}
                aria-describedby={error ? EMAIL_ERROR_ID : undefined}
                data-slot="input"
                data-size="default"
                className={cn(inputClass, fieldClass)}
              />
            </div>
          )}
          {error ? (
            <p id={EMAIL_ERROR_ID} role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || (step === "code" && !needsNewCode && code.length < CODE_LENGTH)}
            className={submitClass}
          >
            {pending ? (
              step === "code" && !needsNewCode ? (
                <Trans>Verifying…</Trans>
              ) : (
                <Trans>Sending code…</Trans>
              )
            ) : needsNewCode ? (
              <Trans>Send a new code</Trans>
            ) : step === "code" ? (
              <Trans>Continue</Trans>
            ) : (
              <Trans>Send code</Trans>
            )}
          </Button>
          {notInvited ? (
            <div
              role="status"
              className="mt-3 w-full rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground"
            >
              <p className="font-medium text-foreground">
                <Trans>VNBot is in limited preview</Trans>
              </p>
              <p className="mt-1 text-pretty">
                {trimmedEmail ? (
                  <Trans>
                    Right now, only invited emails can sign in.{" "}
                    <span className="font-medium text-foreground">{trimmedEmail}</span> isn't on the
                    list yet.
                  </Trans>
                ) : (
                  <Trans>Right now, only invited emails can sign in.</Trans>
                )}
              </p>
              <p className="mt-2">
                <Trans>
                  Want early access?{" "}
                  <a
                    href={VNBOT_CONTACT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                    aria-label={t`Get in touch (opens in new tab)`}
                  >
                    Get in touch
                  </a>
                </Trans>
              </p>
            </div>
          ) : null}
          {step === "code" ? (
            <div className="mt-3 text-center text-body2 text-muted-foreground">
              {resent ? (
                <p role="status">
                  <Trans>New code sent. The old code no longer works.</Trans>
                </p>
              ) : resendIn > 0 ? (
                <p>
                  <Trans>Didn't get it? Resend in {resendLabel}</Trans>
                </p>
              ) : (
                <button
                  type="button"
                  className={linkClass}
                  disabled={pending}
                  onClick={() => void sendCode(true)}
                >
                  <Trans>Resend code</Trans>
                </button>
              )}
            </div>
          ) : null}
          {step === "email" ? (
            <PasskeySignIn disabled={pending} onSignedIn={enterApp} onError={setError} />
          ) : (
            <button
              type="button"
              disabled={pending}
              className={`mt-6 max-md:inline-flex max-md:min-h-11 max-md:items-center ${linkClass}`}
              onClick={chooseDifferentEmail}
            >
              <Trans>Use a different email</Trans>
            </button>
          )}
          {reset.sso && step === "email" ? (
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
        </>
      ) : null}
    </AuthFrame>
  );
}

export function AuthFrame({
  title,
  subtitle,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground">
      {/* Outside the form: picking a language must never submit it. */}
      <LanguageSwitch className="absolute end-5 top-4 max-sm:end-3 max-sm:top-3" />
      <div className="flex w-[460px] max-w-full flex-col items-center">
        <form noValidate onSubmit={onSubmit} className="flex w-full flex-col items-center">
          <VnbotWordmark variant="wordmark" className="h-8 w-auto sm:h-9" />
          <h1
            aria-live="polite"
            className="mt-7 text-center text-4xl font-medium tracking-tight max-sm:text-3xl"
          >
            {title}
          </h1>
          {subtitle ? (
            <p className="mb-9 mt-3 text-center text-body1 text-pretty text-muted-foreground">
              {subtitle}
            </p>
          ) : (
            <div className="mb-9" />
          )}
          {children}
        </form>
        <p className="mt-8 flex gap-4 text-sm text-muted-foreground">
          <a
            href={VNBOT_TERMS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`max-md:inline-flex max-md:min-h-11 max-md:items-center ${linkClass}`}
          >
            <Trans>Terms</Trans>
          </a>
          <a
            href={VNBOT_PRIVACY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`max-md:inline-flex max-md:min-h-11 max-md:items-center ${linkClass}`}
          >
            <Trans>Privacy</Trans>
          </a>
          <a
            href={VNBOT_CONTACT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={`max-md:inline-flex max-md:min-h-11 max-md:items-center ${linkClass}`}
          >
            <Trans>Contact</Trans>
          </a>
        </p>
      </div>
    </div>
  );
}
