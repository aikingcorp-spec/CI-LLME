/** First-run mailbox proof. The code and any session token stay in the main process. */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6}$/;

export interface FirstRunCode {
  email: string;
  code: string;
}

export interface FirstRunResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FirstRunFetch = (url: string, init: RequestInit) => Promise<FirstRunResponse>;

export interface CentralMailbox {
  authUrl: string;
  origin: string;
}

export function parseFirstRunEmail(value: string): string {
  const email = value.trim();
  if (!EMAIL.test(email) || email.length > 320) throw new Error("invalid-email");
  return email;
}

export function parseFirstRunCode(email: string, code: string): FirstRunCode {
  const parsed = parseFirstRunEmail(email);
  const otp = code.trim();
  if (!CODE.test(otp)) throw new Error("invalid-code");
  return { email: parsed, code: otp };
}

/** Public issuer auth base. Rejects anything that is not a pinned HTTPS origin path. */
export function centralAuthBase(authUrl: string): string {
  const url = new URL(authUrl);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid identity issuer");
  }
  return authUrl.replace(/\/$/, "");
}

/** Local sign-in only. A public or credentialed origin cannot receive the code. */
export function localSignInUrl(origin: string): string {
  const url = new URL(origin);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Invalid native origin");
  }
  return new URL("/api/auth/sign-in/email-otp", url.origin).toString();
}

function authPath(authUrl: string, path: string): string {
  return `${centralAuthBase(authUrl)}${path}`;
}

async function postJson(
  fetchImpl: FirstRunFetch,
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<FirstRunResponse> {
  return fetchImpl(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function discard(response: FirstRunResponse) {
  await response.arrayBuffer().catch(() => undefined);
}

export async function sendFirstRunCode(
  fetchImpl: FirstRunFetch,
  mailbox: CentralMailbox,
  email: string,
): Promise<"ok" | "unreachable" | "rejected"> {
  const address = parseFirstRunEmail(email);
  try {
    const response = await postJson(
      fetchImpl,
      authPath(mailbox.authUrl, "/email-otp/send-verification-otp"),
      { email: address, type: "sign-in" },
      { origin: mailbox.origin },
    );
    await discard(response);
    if (response.status === 429 || response.status >= 500) return "unreachable";
    return response.ok ? "ok" : "rejected";
  } catch {
    return "unreachable";
  }
}

/**
 * Proves the code against the central issuer, then ends that session.
 * The token is not returned.
 */
export async function proveCentralMailbox(
  fetchImpl: FirstRunFetch,
  mailbox: CentralMailbox,
  staged: FirstRunCode,
): Promise<"ok" | "unreachable" | "rejected"> {
  const code = parseFirstRunCode(staged.email, staged.code);
  try {
    const response = await postJson(
      fetchImpl,
      authPath(mailbox.authUrl, "/sign-in/email-otp"),
      { email: code.email, otp: code.code },
      { origin: mailbox.origin },
    );
    const token = response.headers.get("set-auth-token");
    await discard(response);
    if (response.status === 429 || response.status >= 500) return "unreachable";
    if (!response.ok || !token) return "rejected";
    const signedOut = await postJson(
      fetchImpl,
      authPath(mailbox.authUrl, "/sign-out"),
      {},
      { origin: mailbox.origin, authorization: `Bearer ${token}` },
    );
    await discard(signedOut);
    return signedOut.ok ? "ok" : "rejected";
  } catch {
    return "unreachable";
  }
}

/** Posts the one-time code to the loopback host. The caller uses the window session. */
export function localSignInRequest(
  origin: string,
  staged: FirstRunCode,
): { url: string; init: RequestInit } {
  const code = parseFirstRunCode(staged.email, staged.code);
  const url = new URL(origin);
  return {
    url: localSignInUrl(origin),
    init: {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", origin: url.origin },
      body: JSON.stringify({ email: code.email, otp: code.code }),
    },
  };
}
