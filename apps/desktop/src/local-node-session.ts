import {
  LOCAL_NODE_SESSION_PATH,
  LOCAL_SETTINGS_TOKEN_HEADER,
} from "@rakazo/contracts/local-settings";
import { isLoopbackHost } from "@rakazo/contracts/network-host";

const REQUEST_TIMEOUT_MS = 10_000;

/** What the app needs from an Electron session's cookie store. */
export interface LocalNodeCookies {
  get(filter: { url: string }): Promise<Array<{ name: string; value: string }>>;
  set(details: {
    url: string;
    name: string;
    value: string;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "no_restriction";
    expirationDate?: number;
  }): Promise<void>;
}

export function parseSessionCookie(line: string, url: string, now = Date.now()) {
  const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
  const split = pair.indexOf("=");
  if (split <= 0) return null;
  const cookie: Parameters<LocalNodeCookies["set"]>[0] = {
    url,
    name: pair.slice(0, split),
    value: pair.slice(split + 1),
    path: "/",
  };
  for (const attribute of attributes) {
    const [rawName = "", value = ""] = attribute.split("=");
    const name = rawName.toLowerCase();
    if (name === "path") cookie.path = value;
    else if (name === "httponly") cookie.httpOnly = true;
    else if (name === "secure") cookie.secure = true;
    else if (name === "samesite") {
      const sameSite = value.toLowerCase();
      if (sameSite === "lax" || sameSite === "strict") cookie.sameSite = sameSite;
      else if (sameSite === "none") cookie.sameSite = "no_restriction";
    } else if (name === "max-age" && /^\d+$/.test(value)) {
      cookie.expirationDate = Math.floor(now / 1000) + Number(value);
    }
  }
  return cookie;
}

/**
 * Leaves the app window's session signed in to this computer's node. A session already open for
 * this address is kept. Otherwise the private stack token and the address the account server
 * verified open one; without a verified address this fails, so setup asks for the code.
 */
export async function ensureLocalNodeSession(input: {
  origin: string;
  token: string;
  email: string | null;
  cookies: LocalNodeCookies;
  request: typeof fetch;
}): Promise<void> {
  const url = new URL(input.origin);
  // The token never leaves this computer, whatever the saved address says.
  if (url.origin !== input.origin || !isLoopbackHost(url.hostname)) {
    throw new Error("Invalid local node target");
  }
  const stored = await input.cookies.get({ url: input.origin });
  const open = await input
    .request(`${input.origin}/api/auth/get-session`, {
      headers: { cookie: stored.map(({ name, value }) => `${name}=${value}`).join("; ") },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    .then((response) =>
      response.ok ? (response.json() as Promise<{ user?: { email?: unknown } } | null>) : null,
    )
    .catch(() => null);
  const openEmail = open?.user?.email;
  if (
    typeof openEmail === "string" &&
    (input.email === null || openEmail.toLowerCase() === input.email.toLowerCase())
  ) {
    return;
  }
  if (input.email === null) throw new Error("No verified address for the local node");
  const response = await input.request(`${input.origin}${LOCAL_NODE_SESSION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [LOCAL_SETTINGS_TOKEN_HEADER]: input.token },
    body: JSON.stringify({ email: input.email }),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The local node refused the session: ${response.status}`);
  const cookies = response.headers
    .getSetCookie()
    .map((line) => parseSessionCookie(line, input.origin))
    .filter((cookie) => cookie !== null);
  if (cookies.length === 0) throw new Error("The local node returned no session");
  for (const cookie of cookies) await input.cookies.set(cookie);
}
