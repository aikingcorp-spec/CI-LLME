// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MachinePicker } from "./MachinePicker";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MachinePicker />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("shows a pairing state without offering a fake connection", () => {
  expect(host.textContent).toContain("Connect by pairing — coming soon");
  expect(host.textContent).not.toContain("This computer");
  expect(host.querySelector('input[name="machine-address"]')).toBeNull();
  expect(host.querySelector('button[type="submit"]')).toBeNull();
  const radios = host.querySelectorAll('[role="radio"]');
  expect(radios).toHaveLength(2);
  expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
  expect(radios[1]!.getAttribute("aria-disabled")).toBe("true");
  expect(radios[1]!.closest("label")?.className).toContain("opacity-50");
});
