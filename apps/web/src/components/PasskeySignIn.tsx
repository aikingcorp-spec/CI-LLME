import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import {
  cancelPasskeyRequest,
  conditionalPasskeyAvailable,
  passkeyErrorText,
  usePasskeysSupported,
} from "../lib/passkeys";

const linkClass =
  "font-medium text-link underline underline-offset-4 hover:decoration-2 rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Passkey sign-in as a secondary line under the email form, plus browser autofill
 * on the email field where conditional UI exists. Hidden on the code step by the caller.
 */
export function PasskeySignIn({
  disabled,
  onSignedIn,
  onError,
}: {
  disabled?: boolean;
  onSignedIn: () => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useLingui();
  const supported = usePasskeysSupported();
  const [pending, setPending] = useState(false);
  const callbacks = useRef({ onSignedIn, onError, t });
  callbacks.current = { onSignedIn, onError, t };
  const mounted = useRef(true);

  async function signIn(autoFill: boolean) {
    const result = await authClient.signIn.passkey({ autoFill }).catch((error: unknown) => ({
      data: null,
      error,
    }));
    if (!mounted.current) return;
    const { onSignedIn, onError, t } = callbacks.current;
    if (result.error) {
      const message = passkeyErrorText(result.error, t`Could not continue`);
      if (message) onError(message);
      return;
    }
    onSignedIn();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelPasskeyRequest();
    };
  }, []);

  useEffect(() => {
    if (!supported) return;
    void conditionalPasskeyAvailable().then((available) => {
      if (available && mounted.current) void signIn(true);
    });
  }, [supported]);

  if (!supported) return null;
  return (
    <p className="mt-6 text-center text-body1 text-muted-foreground">
      <Trans>Already set up a passkey?</Trans>{" "}
      <button
        type="button"
        disabled={disabled || pending}
        className={`${linkClass} disabled:opacity-50`}
        onClick={() => {
          setPending(true);
          onError(null);
          void signIn(false).finally(() => {
            if (mounted.current) setPending(false);
          });
        }}
      >
        <Trans>Sign in with a passkey</Trans>
      </button>
    </p>
  );
}
