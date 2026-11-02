const SOCKET_PATH =
  /^\/novnc\/session\/(view|control)\/[0-9]{10,16}\.[A-Za-z0-9_-]{20,12000}\/websockify$/;
export function isScreenSocketPath(path: string): boolean {
  return SOCKET_PATH.test(path);
}

/** API-issued embed pages use either a relative socket or the same sealed capability prefix. */
export function screenSocketPath(pageUrl: string): string {
  const url = new URL(pageUrl);
  const slash = url.pathname.lastIndexOf("/");
  const expected = `${url.pathname.slice(0, slash + 1)}websockify`;
  const configured = url.searchParams.get("path");
  if (!isScreenSocketPath(expected) || (configured !== "websockify" && configured !== expected))
    throw new Error("invalid screen capability path");
  return expected;
}
