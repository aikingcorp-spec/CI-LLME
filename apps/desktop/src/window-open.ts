const OAUTH_POPUP_NAMES = new Set([
  "rakazo-app-connect",
  "rakazo-mcp-oauth",
  "rakazo-sso-oauth",
  "rakazo-model-oauth",
  "rakazo-plugin-connect",
]);

const RESERVED_OAUTH_PREFIXES = new Set([
  "vnbot-plugin-connect",
  "vnbot-app-connect",
  "rakazo-mcp-oauth",
]);

function isReservedOAuthAttempt(name: string): boolean {
  const separator = name.indexOf(":");
  return (
    RESERVED_OAUTH_PREFIXES.has(name.slice(0, separator)) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      name.slice(separator + 1),
    )
  );
}

export function shouldOpenInAppPopup(
  appOrigin: string | null,
  childUrl: string,
  frameName: string,
) {
  let target: URL;
  try {
    target = new URL(childUrl);
  } catch {
    return false;
  }

  const reservedAttempt = isReservedOAuthAttempt(frameName);
  if (childUrl === "about:blank") return frameName === "rakazo-sso-oauth" || reservedAttempt;

  const isHttp = target.protocol === "http:" || target.protocol === "https:";
  if (appOrigin !== null && target.origin === appOrigin) return isHttp;
  return target.protocol === "https:" && (OAUTH_POPUP_NAMES.has(frameName) || reservedAttempt);
}

/** Keep auth cookies in the parent app's server-specific session. */
export function oauthPopupSessionPreferences(partition: string | null) {
  return {
    preload: "",
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    ...(partition === null ? {} : { partition }),
  };
}
