import { describe, expect, it } from "vitest";
import { welcomeEmail } from "./welcome-email.js";

describe("welcomeEmail", () => {
  const url = "https://app.example.test/unsubscribe?token=fake-token";

  it("greets in Vietnamese, signed by the VNBot team", async () => {
    const message = await welcomeEmail({ email: "ada@example.test", name: "Ada" }, url);
    expect(message.subject).toBe("Chào mừng bạn đến với VNBot");
    expect(message.text).toContain("Chào Ada");
    expect(message.text).not.toContain("Hi Ada");
    expect(message.text).toContain("Đội VNBot");
    expect(message.text).toContain(url);
    expect(message.headers).toEqual({
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("falls back to a neutral greeting and carries no outside links", async () => {
    const message = await welcomeEmail({ email: "ada@example.test", name: "" }, url);
    expect(message.text).toContain("Chào bạn");
    expect(message.text).not.toContain("Hi there");
    const html = message.html ?? "";
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    expect(links.every((href) => href?.startsWith("https://app.example.test/"))).toBe(true);
    expect(html).not.toMatch(/github|discord|open source|Elie/i);
  });
});
