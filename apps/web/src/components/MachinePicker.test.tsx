// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MachinePicker, normalizeMachineUrl } from "./MachinePicker";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onThisComputer = vi.fn();
const onOwnMachine = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<MachinePicker onThisComputer={onThisComputer} onOwnMachine={onOwnMachine} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function radio(index: number) {
  return host.querySelectorAll<HTMLElement>('[role="radio"]')[index]!;
}
function continueButton() {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === "Continue")!;
}
async function typeAddress(value: string) {
  const input = host.querySelector('input[name="machine-address"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("normalizes what a person types to an http(s) origin", () => {
  expect(normalizeMachineUrl(" vps.example.com/app ")).toBe("https://vps.example.com");
  expect(normalizeMachineUrl("https://vps.example.com:8443/x")).toBe(
    "https://vps.example.com:8443",
  );
  expect(normalizeMachineUrl("192.168.1.5:6130")).toBe("http://192.168.1.5:6130");
  expect(normalizeMachineUrl("http://localhost:5173")).toBe("http://localhost:5173");
});

it("rejects addresses that are not safe to open", () => {
  for (const input of [
    "",
    "   ",
    "http://vps.example.com",
    "ftp://vps.example.com",
    "javascript://alert(1)",
    "https://user:secret@vps.example.com",
    "not a server",
  ])
    expect(normalizeMachineUrl(input), input).toBeNull();
});

it("continues with This computer by default", async () => {
  expect(host.querySelector('input[name="machine-address"]')).toBeNull();
  await act(async () => continueButton().click());
  expect(onThisComputer).toHaveBeenCalledOnce();
  expect(onOwnMachine).not.toHaveBeenCalled();
});

it("opens the normalized address of the person's own machine", async () => {
  await act(async () => radio(1).click());
  await typeAddress("vps.example.com");
  await act(async () => continueButton().click());
  expect(onOwnMachine).toHaveBeenCalledExactlyOnceWith("https://vps.example.com");
  expect(onThisComputer).not.toHaveBeenCalled();
});

it("stays on the picker and marks an invalid address", async () => {
  await act(async () => radio(1).click());
  await typeAddress("http://vps.example.com");
  await act(async () => continueButton().click());
  expect(onOwnMachine).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(
    "Enter a valid http:// or https:// address.",
  );
  expect(host.querySelector('input[name="machine-address"]')!.getAttribute("aria-invalid")).toBe(
    "true",
  );
});

it("cannot select VNBot Cloud", async () => {
  await act(async () => radio(2).click());
  expect(radio(2).getAttribute("aria-checked")).toBe("false");
  expect(radio(0).getAttribute("aria-checked")).toBe("true");
});
