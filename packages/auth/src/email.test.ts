import { describe, expect, it } from "vitest";
import {
  accountDeletionEmail,
  identityCodeEmail,
  passwordResetEmail,
  signInCodeEmail,
  signInCodeLocale,
  verificationEmail,
} from "./email.js";
import { welcomeEmail } from "./welcome-email.js";

describe("account email templates", () => {
  const url = "https://app.example.test/verify?token=fake-token&callbackURL=%2Fsign-in";

  it.each([
    ["verification", () => verificationEmail("user@example.test", url)],
    [
      "password reset",
      () => passwordResetEmail({ id: "user-1", email: "user@example.test", name: "Test" }, url),
    ],
  ] as const)("preserves the exact %s link in HTML and text", async (_name, create) => {
    const message = await create();
    expect(message.to).toBe("user@example.test");
    expect(message.text).toContain(url);
    expect(message.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it("defaults sign-in codes to Vietnamese and switches to English when asked", async () => {
    expect(signInCodeLocale(undefined)).toBe("vi");
    expect(signInCodeLocale("vi-VN")).toBe("vi");
    expect(signInCodeLocale("fr")).toBe("vi");
    expect(signInCodeLocale("en-US")).toBe("en");
    const english = await signInCodeEmail("ada@example.test", "042517", {
      locale: "en",
      assetBase: "https://app.example.test/email",
    });
    expect(english.subject).toBe("Your VNBot sign-in code");
    expect(english.subject).not.toContain("042517");
    expect(english.html).toContain("Your sign-in code");
    expect(english.html).not.toContain("{{CODE}}");
    expect(english.text).toContain("042517");
  });

  it.each([signInCodeEmail, accountDeletionEmail])(
    "escapes code content and includes a plain-text fallback",
    async (create) => {
      const message = await create("user@example.test", "<script>fake-code</script>");
      expect(message.text).toContain("<script>fake-code</script>");
      expect(message.html).toContain("&lt;script&gt;fake-code&lt;/script&gt;");
      expect(message.html).not.toContain("<script>");
      expect(message.html).not.toContain("<a ");
    },
  );

  it.each([
    ["sign-in code vi", () => signInCodeEmail("user@example.test", "123456")],
    ["sign-in code en", () => signInCodeEmail("user@example.test", "123456", { locale: "en" })],
    ["verification", () => verificationEmail("user@example.test", url)],
    [
      "password reset",
      () => passwordResetEmail({ id: "user-1", email: "user@example.test", name: "Test" }, url),
    ],
    ["account deletion", () => accountDeletionEmail("user@example.test", "123456")],
    ["identity code", () => identityCodeEmail("user@example.test", "123456")],
    [
      "welcome",
      () => welcomeEmail({ email: "user@example.test", name: "Test" }, "https://u.example.test"),
    ],
  ] as const)("%s email is VNBot-branded only", async (_name, create) => {
    const message = await create();
    for (const part of [message.subject, message.html, message.text]) {
      expect(part).not.toMatch(/rakazo|open.?source|mã nguồn mở|github\.com|discord/i);
    }
    expect(message.subject).toMatch(/VNBot/);
    expect(message.text).toContain("Đội VNBot");
    expect(message.html).toContain("Đội VNBot");
  });
});
