import { WEB_APP_NOT_INCLUDED } from "@rakazo/contracts";

let refused = false;
const listeners = new Set<() => void>();

/** The hosted server refused this account's web app: it is listed for the desktop app only. */
export function webAppRefused(): boolean {
  return refused;
}

export function subscribeWebAppRefusal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads an API reply; only a 403 is opened, and only its copy. */
export async function noteWebAppAccess(response: Response): Promise<void> {
  if (refused || response.status !== 403) return;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const json = body && typeof body === "object" && "json" in body ? body.json : null;
  if (!json || typeof json !== "object" || !("code" in json)) return;
  if (json.code !== WEB_APP_NOT_INCLUDED) return;
  refused = true;
  for (const listener of listeners) listener();
}
