import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";
import { LogoAvatar } from "./logo-avatar.js";

describe("owner avatar", () => {
  it("renders the full owner image with an accessible label", () => {
    const html = renderToString(<LogoAvatar activity="reading" label="Inbox is reading" />);
    expect(html).toContain("owner-avatar.png");
    expect(html).toContain('alt="Inbox is reading"');
    expect(html).toContain('data-activity="reading"');
    expect(html).not.toContain("<svg");
  });

  it("keeps uploaded bot pictures intact", () => {
    const html = renderToString(<BotAvatar color="data:image/png;base64,abc" avatarSet="rakazo" />);
    expect(html).toContain('src="data:image/png;base64,abc"');
  });

  it("shows the VNBot set for imported legacy bots", () => {
    const html = renderToString(<BotAvatar color="#8B5CF6" avatarSet="rakazo" />);
    expect(html).toContain("data-vnbot-shape");
    expect(html).not.toContain("rakazo-logo-avatar");
  });
});
