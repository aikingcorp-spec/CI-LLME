/** Only fixed routes are logged by name: node ids and tokens never reach a log line. */
export function loggedPath(pathname: string): string {
  if (pathname.startsWith("/nodes/")) return "/nodes/*";
  return [
    "/healthz",
    "/turn-credentials",
    "/agent",
    "/signal",
    "/pair/start",
    "/pair/complete",
    "/sessions",
    "/nodes",
  ].includes(pathname)
    ? pathname
    : "*";
}
