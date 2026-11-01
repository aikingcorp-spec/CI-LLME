/** The existing OTP account protocol. Credentials remain in main and are never persisted. */
export function remoteAccount(request: typeof fetch = fetch, origin = "https://app.vnbot.run") {
  const post = async (
    path: string,
    body: unknown,
    bearer?: string,
  ): Promise<Record<string, unknown>> => {
    const response = await request(`${origin}/api/auth/${path}`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        origin,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Account request refused");
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error("Invalid account response");
    return result as Record<string, unknown>;
  };
  return {
    send: (email: string) => post("email-otp/send-verification-otp", { email, type: "sign-in" }),
    async authorize(email: string, otp: string) {
      const signedIn = await post("sign-in/email-otp", { email, otp });
      const user = signedIn.user;
      if (
        !user ||
        typeof user !== "object" ||
        !("email" in user) ||
        user.email !== email ||
        typeof signedIn.token !== "string"
      )
        throw new Error("Account verification failed");
      try {
        const result = await post("p2p-token", { scope: ["pair"] }, signedIn.token);
        if (typeof result.token !== "string") throw new Error("Missing registration credential");
        return result.token;
      } finally {
        await post("sign-out", {}, signedIn.token).catch(() => undefined);
      }
    },
  };
}
