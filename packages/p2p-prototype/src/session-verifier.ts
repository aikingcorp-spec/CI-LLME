import { createHash } from "node:crypto";

export type VerifyResult =
  | { ok: true; user: { id: string; email: string } }
  | { ok: false; status: 401; code: "NO_SESSION" | "EMAIL_NOT_INVITED" }
  | { ok: false; status: 502; code: "AUTH_UNAVAILABLE" };

export interface UserVerifier {
  verify(req: { cookie?: string; authorization?: string }): Promise<VerifyResult>;
}

interface HttpSessionVerifierOptions {
  authBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  timeoutMs?: number;
  clock?: () => number;
}

export function createHttpSessionVerifier(o: HttpSessionVerifierOptions): UserVerifier {
  const base = new URL(o.authBaseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("AUTH_BASE_URL must be an http(s) URL without credentials");
  }
  const url = new URL("/api/auth/get-session", base);
  const clock = o.clock ?? Date.now;
  const request = o.fetch ?? globalThis.fetch;
  const cache = new Map<string, { result: VerifyResult; expiresAt: number }>();
  const noSession: VerifyResult = { ok: false, status: 401, code: "NO_SESSION" };
  const unavailable: VerifyResult = { ok: false, status: 502, code: "AUTH_UNAVAILABLE" };
  return {
    async verify(req) {
      const authorization = /^Bearer [^\s]+$/i.test(req.authorization ?? "")
        ? req.authorization
        : undefined;
      const cookie = req.cookie;
      if (!cookie && !authorization) return noSession;
      const key = createHash("sha256")
        .update(JSON.stringify([cookie ?? null, authorization ?? null]))
        .digest("hex");
      const hit = cache.get(key);
      if (hit && hit.expiresAt > clock()) return hit.result;
      cache.delete(key);
      const headers: Record<string, string> = {};
      if (cookie) headers.Cookie = cookie;
      if (authorization) headers.Authorization = authorization;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 5_000);
      try {
        const res = await request(url, {
          headers,
          signal: controller.signal,
          redirect: "error",
          cache: "no-store",
        });
        let result: VerifyResult;
        let cacheExpiresAt = clock() + (o.negativeCacheTtlMs ?? 5_000);
        if (res.status === 401) {
          const body: unknown = await res.json();
          result = {
            ok: false,
            status: 401,
            code:
              isRecord(body) && body.code === "EMAIL_NOT_INVITED"
                ? "EMAIL_NOT_INVITED"
                : "NO_SESSION",
          };
        } else if (res.status === 200) {
          const body: unknown = await res.json();
          if (body === null) result = noSession;
          else {
            if (!isRecord(body) || !isRecord(body.user) || !isRecord(body.session))
              return unavailable;
            const { id, email } = body.user;
            const expiresAt =
              typeof body.session.expiresAt === "string"
                ? Date.parse(body.session.expiresAt)
                : Number.NaN;
            if (
              typeof id !== "string" ||
              !id ||
              typeof email !== "string" ||
              !email ||
              !Number.isFinite(expiresAt)
            )
              return unavailable;
            if (expiresAt <= clock()) result = noSession;
            else {
              result = { ok: true, user: { id, email } };
              cacheExpiresAt = Math.min(clock() + (o.cacheTtlMs ?? 30_000), expiresAt);
            }
          }
        } else return unavailable;
        if (cacheExpiresAt > clock()) {
          for (const [hash, entry] of cache) if (entry.expiresAt <= clock()) cache.delete(hash);
          if (cache.size >= 1_000) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          cache.set(key, { result, expiresAt: cacheExpiresAt });
        }
        return result;
      } catch {
        return unavailable;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
