import { describe, expect, it, vi } from "vitest";
import { remoteAccount } from "./p2p-account.js";

describe("desktop remote account proof", () => {
  it("uses the OTP server's credential to request enrollment and then closes that session", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ user: { email: "person@example.test" }, token: "signed-session" }),
      )
      .mockResolvedValueOnce(Response.json({ token: "scoped-token" }))
      .mockResolvedValueOnce(Response.json({ success: true }));
    expect(await remoteAccount(request).authorize("person@example.test", "123456")).toBe(
      "scoped-token",
    );
    expect(request.mock.calls[1]?.[0]).toBe("https://app.vnbot.run/api/auth/p2p-token");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer signed-session",
    );
    expect(request.mock.calls[2]?.[0]).toBe("https://app.vnbot.run/api/auth/sign-out");
    for (const [, init] of request.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
    }
  });
  it("refuses a returned email alone or a different account", async () => {
    for (const body of [
      { user: { email: "person@example.test" } },
      { user: { email: "other@example.test" }, token: "signed-session" },
    ]) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(
        remoteAccount(request).authorize("person@example.test", "123456"),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    }
  });
});
