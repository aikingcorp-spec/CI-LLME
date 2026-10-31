import { describe, expect, it, vi } from "vitest";
import {
  AccountOtpError,
  accountBaseUrl,
  accountOtpErrorText,
  createAccountOtpClient,
  isPlausibleEmail,
} from "./account-otp.js";
import { RAKAZO_CLOUD_URL } from "./setup-config.js";
import { stringsFor } from "./strings.js";

const BASE = "https://accounts.example";

function client(response: Response | Error) {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    otp: createAccountOtpClient({ baseUrl: BASE, fetch: fetchImpl as unknown as typeof fetch }),
    fetchImpl,
  };
}

function failure(status: number, code?: string) {
  return Response.json(code ? { code, message: "server text" } : {}, { status });
}

describe("accountBaseUrl", () => {
  it("defaults to the hosted app and accepts a valid override", () => {
    expect(accountBaseUrl(undefined)).toBe("https://app.vnbot.run");
    expect(accountBaseUrl("")).toBe(RAKAZO_CLOUD_URL);
    expect(accountBaseUrl("https://accounts.example/path")).toBe(BASE);
  });

  it("ignores an override that could not carry a sign-in safely", () => {
    expect(accountBaseUrl("http://accounts.example")).toBe(RAKAZO_CLOUD_URL);
    expect(accountBaseUrl("not a url")).toBe(RAKAZO_CLOUD_URL);
  });
});

describe("isPlausibleEmail", () => {
  it("accepts an address shape and rejects everything else", () => {
    expect(isPlausibleEmail("lan@vnbot.vn")).toBe(true);
    for (const value of ["", "lan", "lan@", "@vnbot.vn", "a b@vnbot.vn", 1, null])
      expect(isPlausibleEmail(value), String(value)).toBe(false);
  });
});

describe("account OTP client", () => {
  it("asks for a sign-in code in the app's language without keeping cookies", async () => {
    const { otp, fetchImpl } = client(Response.json({ success: true }));
    await otp.sendCode("lan@vnbot.vn", "vi");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/auth/email-otp/send-verification-otp`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "lan@vnbot.vn", type: "sign-in" });
    expect(init.headers).toMatchObject({ origin: BASE, "x-rakazo-locale": "vi" });
    expect(init.credentials).toBe("omit");
  });

  it("returns only the verified address from a sign-in", async () => {
    const { otp, fetchImpl } = client(
      Response.json({ token: "session-token", user: { email: "lan@vnbot.vn", id: "u1" } }),
    );
    await expect(otp.verifyCode("LAN@vnbot.vn", "123456")).resolves.toBe("lan@vnbot.vn");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/auth/sign-in/email-otp`);
    expect(JSON.parse(String(init.body))).toEqual({ email: "LAN@vnbot.vn", otp: "123456" });
    expect(init.credentials).toBe("omit");
  });

  it("does not treat a success without an address as verified", async () => {
    const { otp } = client(Response.json({ token: "session-token" }));
    await expect(otp.verifyCode("lan@vnbot.vn", "123456")).rejects.toMatchObject({
      kind: "failed",
    });
  });

  it.each([
    [failure(400, "INVALID_OTP"), "invalid-code"],
    [failure(400, "OTP_EXPIRED"), "expired"],
    [failure(403, "TOO_MANY_ATTEMPTS"), "expired"],
    [failure(403, "EMAIL_NOT_INVITED"), "not-invited"],
    [failure(429), "rate-limited"],
    [failure(404), "unavailable"],
    [failure(500), "unavailable"],
    [new Response("<html>", { status: 502 }), "unavailable"],
    [new TypeError("fetch failed"), "unavailable"],
    [new DOMException("timed out", "TimeoutError"), "unavailable"],
  ])("maps a failed request to a typed error (%#)", async (response, kind) => {
    const { otp } = client(response);
    await expect(otp.verifyCode("lan@vnbot.vn", "123456")).rejects.toMatchObject({ kind });
  });
});

describe("accountOtpErrorText", () => {
  it.each(["vi", "en"] as const)("localizes every kind in %s, never server text", (locale) => {
    const text = stringsFor(locale).setup;
    expect(accountOtpErrorText(new AccountOtpError("invalid-code"), text)).toBe(text.otpInvalid);
    expect(accountOtpErrorText(new AccountOtpError("expired"), text)).toBe(text.otpExpired);
    expect(accountOtpErrorText(new AccountOtpError("not-invited"), text)).toBe(text.otpNotInvited);
    expect(accountOtpErrorText(new AccountOtpError("rate-limited"), text)).toBe(
      text.otpRateLimited,
    );
    expect(accountOtpErrorText(new AccountOtpError("unavailable"), text)).toBe(text.otpUnavailable);
    expect(accountOtpErrorText(new AccountOtpError("failed"), text)).toBe(text.otpFailed);
    expect(accountOtpErrorText(new Error("server text"), text)).toBe(text.otpFailed);
  });
});
