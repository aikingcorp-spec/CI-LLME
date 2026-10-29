import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpSessionVerifier } from "./session-verifier.js";

export type FakeSession =
  | { id: string; email: string; expiresAt?: number }
  | "expired"
  | "not-invited"
  | "down"
  | "timeout";
/** Offline Better Auth fixture for verifier and gateway integration tests. */
export async function startFakeAuthServer() {
  const sessions = new Map<string, FakeSession>([
    ["token", { id: "user", email: "user@example.test" }],
    ["test-token", { id: "user", email: "user@example.test" }],
    ["other-token", { id: "other", email: "other@example.test" }],
  ]);
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push({ ...req.headers });
    if (req.method !== "GET" || req.url !== "/api/auth/get-session") {
      res.writeHead(404).end();
      return;
    }
    const token =
      req.headers.authorization?.replace(/^Bearer /i, "") ??
      req.headers.cookie
        ?.split("; ")
        .find((part) => part.startsWith("better-auth.session_token="))
        ?.slice("better-auth.session_token=".length);
    const entry = sessions.get(token ?? "");
    if (entry === "timeout") return;
    const status = entry === "down" ? 500 : entry === "not-invited" ? 401 : 200;
    const body =
      entry === "not-invited"
        ? { code: "EMAIL_NOT_INVITED", message: "Not invited" }
        : typeof entry === "object"
          ? {
              session: {
                expiresAt: new Date(entry.expiresAt ?? Date.now() + 3_600_000).toISOString(),
              },
              user: { id: entry.id, email: entry.email, emailVerified: true },
            }
          : null;
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    sessions,
    requests,
    verifier: createHttpSessionVerifier({ authBaseUrl: url }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
