import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { loadEnv } from "./env.js";
import { readBuildTime, versionRoutes } from "./version.js";

describe("public deployment version", () => {
  it("serves only version metadata without authentication, including through a proxy", async () => {
    const auth = vi.fn(() => new Response(null, { status: 401 }));
    const app = new Hono();
    app.route("/", versionRoutes({ gitSha: "abc1234", builtAt: "2026-10-29T13:00:00Z" }));
    app.all("/api/auth/*", auth);
    app.all("/rpc/*", auth);
    const response = await app.request("/api/version", {
      headers: { "x-forwarded-for": "203.0.113.1", forwarded: "proto=https" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ sha: "abc1234", builtAt: "2026-10-29T13:00:00Z" });
    expect(auth).not.toHaveBeenCalled();
    expect((await app.request("/rpc/health")).status).toBe(401);
  });

  it("returns null for missing metadata", async () => {
    const response = await versionRoutes({}).request("/api/version");
    expect(await response.json()).toEqual({ sha: null, builtAt: null });
  });

  it("uses the image timestamp when the deploy passes only GIT_SHA", async () => {
    const directory = mkdtempSync(join(tmpdir(), "build-time-"));
    const path = join(directory, "BUILT_AT");
    try {
      expect(readBuildTime(path)).toBeUndefined();
      writeFileSync(path, "\n");
      expect(readBuildTime(path)).toBeUndefined();
      writeFileSync(path, "2026-10-29T13:00:00Z\n");
      const env = loadEnv({
        NODE_ENV: "test",
        DATABASE_URL: "postgres://fake.invalid/test",
        GIT_SHA: "abc1234",
      });
      // The file reader is the same fallback loadEnv uses at the image's fixed location.
      const response = await versionRoutes({ ...env, builtAt: readBuildTime(path) }).request(
        "/api/version",
      );
      expect(await response.json()).toEqual({ sha: "abc1234", builtAt: "2026-10-29T13:00:00Z" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
