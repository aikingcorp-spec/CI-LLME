import { useState } from "react";
import { useSignOut } from "../lib/sign-out";
import { AccountMenu } from "./AccountMenu";

/** Keeps account switching available before the main shell can open. */
export function PageAccountMenu({
  destination = "/sign-in",
  className,
}: {
  destination?: string;
  className?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const { signingOut, logOut } = useSignOut(destination, setError);
  return (
    <>
      <AccountMenu className={className} signingOut={signingOut} onLogOut={() => void logOut()} />
      {error ? (
        <p
          role="alert"
          className="fixed top-16 right-6 left-6 text-center text-body-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
