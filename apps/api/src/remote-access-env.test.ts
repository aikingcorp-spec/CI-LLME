import { expect, it } from "vitest";
import { localRemoteOrigin, parseRemoteAccessEnv } from "./remote-access-env.js";

const token = "control-token-must-not-leak";

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

it("names one label under the portal name the current certificate covers", () => {
  const origin = localRemoteOrigin("device-1", "app.vnbot.run");
  expect(origin).toMatch(/^https:\/\/h[a-f0-9]{32}\.app\.vnbot\.run$/);
});
