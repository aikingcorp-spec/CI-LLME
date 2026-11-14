import { describe, expect, it, vi } from "vitest";
import type { FirstRunFetch, FirstRunResponse } from "./first-run-email.js";
import {
  localSignInRequest,
  localSignInUrl,
  proveCentralMailbox,
  sendFirstRunCode,
} from "./first-run-email.js";

const mailbox = {
  authUrl: "https://issuer.example.test/api/auth",
  origin: "https://app.example.test",
};

function response(status: number, token?: string): FirstRunResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name === "set-auth-token" ? (token ?? null) : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe("first-run email", () => {
  it("sends a sign-in code to the pinned issuer and does not return a body", async () => {
    const fetchImpl = vi.fn<FirstRunFetch>(async () => response(200));
    await expect(sendFirstRunCode(fetchImpl, mailbox, "ada@example.test")).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://issuer.example.test/api/auth/email-otp/send-verification-otp",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "ada@example.test", type: "sign-in" }),
      }),
    );
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ origin: "https://app.example.test" });
    expect(JSON.stringify(init)).not.toContain("otp");
  });

  it("refuses an issuer that is not https", async () => {
    const fetchImpl = vi.fn<FirstRunFetch>();
    await expect(
      sendFirstRunCode(
        fetchImpl,
        { authUrl: "http://issuer.example.test/api/auth", origin: "https://app.example.test" },
        "ada@example.test",
      ),
    ).resolves.toBe("unreachable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("proves a code and signs that central session out without returning the token", async () => {
    const fetchImpl = vi.fn<FirstRunFetch>(async (url) =>
      String(url).endsWith("/sign-out") ? response(200) : response(200, "session-secret"),
    );
    const result = await proveCentralMailbox(fetchImpl, mailbox, {
      email: "ada@example.test",
      code: "123456",
    });
    expect(result).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("session-secret");
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://issuer.example.test/api/auth/sign-out",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer session-secret" }),
      }),
    );
  });

  it("treats a missing token or a failed sign-out as rejected", async () => {
    const missing = vi.fn<FirstRunFetch>(async () => response(200));
    await expect(
      proveCentralMailbox(missing, mailbox, { email: "ada@example.test", code: "123456" }),
    ).resolves.toBe("rejected");
    const stuck = vi.fn<FirstRunFetch>(async (url) =>
      String(url).endsWith("/sign-out") ? response(500) : response(200, "session-secret"),
    );
    await expect(
      proveCentralMailbox(stuck, mailbox, { email: "ada@example.test", code: "123456" }),
    ).resolves.toBe("rejected");
  });

  it("builds a loopback sign-in and refuses a public origin", () => {
    expect(localSignInUrl("http://127.0.0.1:45173")).toBe(
      "http://127.0.0.1:45173/api/auth/sign-in/email-otp",
    );
    expect(() => localSignInUrl("https://app.example.test")).toThrow("Invalid native origin");
    expect(() => localSignInUrl("http://192.168.1.9:45173")).toThrow("Invalid native origin");
    const request = localSignInRequest("http://127.0.0.1:45173", {
      email: "ada@example.test",
      code: "123456",
    });
    expect(request.url).toBe("http://127.0.0.1:45173/api/auth/sign-in/email-otp");
    expect(request.init.body).toBe(JSON.stringify({ email: "ada@example.test", otp: "123456" }));
    expect(request.url).not.toContain("123456");
  });
});
