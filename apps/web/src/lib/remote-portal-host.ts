/** The remote entry host. Other hosts keep the local app. */
export const REMOTE_PORTAL_HOST = "app.vnbot.run";

export function isRemotePortalHost(hostname: string): boolean {
  return hostname === REMOTE_PORTAL_HOST;
}
