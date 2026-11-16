import { expect, it } from "vitest";
import { loadEnv } from "./env.js";
import { localRemoteOrigin, parseRemoteAccessEnv } from "./remote-access-env.js";

const token = "control-token-must-not-leak";

it("loads only the exact remote origin for a native VNBot device", async () => {
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://fake:fake@localhost/fake",
    WEB_ORIGIN: "http://127.0.0.1:5173",
    RAKAZO_IDENTITY_EXCHANGE: JSON.stringify({
      kind: "local",
      deviceId: "device-1",
      issuer: "https://app.vnbot.run",
      audience: "local-session",
      publicKey: "unused-for-sign-out",
      centralAuthUrl: "https://app.vnbot.run/api/auth",
      centralOrigin: "https://app.vnbot.run",
    }),
  });
  const origin = localRemoteOrigin("device-1", "vnbot.run");
  expect(env.extraAuthOrigins).toEqual([origin]);
});

it("rejects a control configuration without repeating the token", () => {
  expect(parseRemoteAccessEnv(undefined)).toBeUndefined();
  expect(() => parseRemoteAccessEnv("{")).toThrow("Remote access configuration is invalid");
  try {
    parseRemoteAccessEnv("{");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("{");
  }
  const parsed = parseRemoteAccessEnv(
    JSON.stringify({
      accountId: "a".repeat(32),
      zoneId: "b".repeat(32),
      apiToken: token,
      nameSuffix: "app.vnbot.run",
    }),
  );
  expect(parsed?.nameSuffix).toBe("app.vnbot.run");
  expect(JSON.stringify({ nameSuffix: parsed?.nameSuffix })).not.toContain(token);
  expect(() =>
    parseRemoteAccessEnv(
      JSON.stringify({
        accountId: "a".repeat(32),
        zoneId: "b".repeat(32),
        apiToken: token,
        nameSuffix: "not a host",
      }),
    ),
  ).toThrow("Remote access name is invalid");
});

it("uses the official suffix only for the pinned VNBot issuer", () => {
  const origin = localRemoteOrigin("device-1", undefined, "https://app.vnbot.run");
  expect(origin).toMatch(/^https:\/\/h[a-f0-9]{32}\.vnbot\.run$/);
  expect(localRemoteOrigin("device-2", undefined, "https://app.vnbot.run")).not.toBe(origin);
  expect(localRemoteOrigin("device-1", undefined)).toBeUndefined();
  expect(localRemoteOrigin("device-1", undefined, "https://identity.example.test")).toBeUndefined();
  expect(
    localRemoteOrigin("device-1", undefined, "https://app.vnbot.run.evil.test"),
  ).toBeUndefined();
});

it("keeps explicitly configured deployment suffixes", () => {
  expect(localRemoteOrigin("device-1", "remote.example.test", "https://app.vnbot.run")).toMatch(
    /^https:\/\/h[a-f0-9]{32}\.remote\.example\.test$/,
  );
  expect(() => localRemoteOrigin("device-1", "*.vnbot.run", "https://app.vnbot.run")).toThrow();
});
