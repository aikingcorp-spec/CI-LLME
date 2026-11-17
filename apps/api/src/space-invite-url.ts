/** Native invitations enter through the pinned portal, never through a loopback web host. */
export function spaceInviteUrl(
  token: string,
  input: { webOrigin: string; deviceId?: string; shortCode?: string; portalOrigin?: string },
): string {
  const device = input.shortCode || input.deviceId;
  if (!device) return new URL(`/invite/${encodeURIComponent(token)}`, input.webOrigin).href;
  if (!input.portalOrigin) throw new Error("Remote invitation portal is not configured");
  const portal = new URL(input.portalOrigin);
  if (portal.protocol !== "https:" || portal.origin !== input.portalOrigin) {
    throw new Error("Remote invitation portal is invalid");
  }
  const entry = new URL("/remote-join", portal);
  entry.hash = new URLSearchParams({ device, invite: token }).toString();
  return entry.href;
}
