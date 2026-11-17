// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));

import { useSettingsNavItems } from "./settings-nav";

function NavProbe() {
  const items = useSettingsNavItems({
    messaging: false,
    wallet: false,
    computer: false,
    billing: false,
    updates: false,
    labs: false,
  });
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.id}</li>
      ))}
    </ul>
  );
}

it("lists Messaging before any chat provider is mounted", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<NavProbe />);
    });
    const ids = [...container.querySelectorAll("li")].map((item) => item.textContent);
    expect(ids).toContain("messaging");
    expect(ids).not.toContain("billing");
    expect(ids).not.toContain("organization");
    expect(ids.indexOf("vault")).toBeLessThan(ids.indexOf("messaging"));
    expect(ids.indexOf("messaging")).toBeLessThan(ids.indexOf("memory"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
