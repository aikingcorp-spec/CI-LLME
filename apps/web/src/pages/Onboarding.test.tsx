// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ load: (_me: unknown) => {} }));

vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => null,
  rpc: {
    me: vi.fn(
      () =>
        new Promise((resolve) => {
          account.load = resolve;
        }),
    ),
    models: {
      list: vi.fn(async () => [
        {
          provider: "openai-compatible",
          providerName: "OpenAI-compatible",
          id: "",
          label: "Custom",
          billing: "API key",
        },
      ]),
      probeOpenAiCompatible: vi.fn(async () => ({
        models: Array.from({ length: 11 }, (_, index) => `found-${index}`),
      })),
    },
    preferences: { update: vi.fn(async () => ({})) },
    bots: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: "bot-1" })),
    },
    onboarding: {
      start: vi.fn(async () => undefined),
      promptFocus: vi.fn(async () => undefined),
    },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});

import { setCatalogLoadersForTests } from "../lib/i18n";
import { rpc } from "../lib/rpc";
import { OnboardingPage } from "./Onboarding";
import { ensureFirstBot } from "./onboarding/first-bot";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("marks onboarding as usable for the desktop only once a step shows", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  // The shell sends a new account to /onboarding, which loads before it picks a step.
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  const marked = () => host.querySelector('[data-rakazo-surface="onboarding"]');
  expect(marked()).toBeNull();

  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(marked()).not.toBeNull();
  act(() => root.unmount());
});

it("finds and searches a long custom endpoint list during onboarding", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "OpenAI-compatible")!
      .click(),
  );
  const change = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change("OpenAI-compatible server URL", "https://models.example.test/v1");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Find models")!
      .click(),
  );
  // Onboarding probes the endpoint the same way model settings does.
  expect(rpc.models.probeOpenAiCompatible).toHaveBeenCalledWith(
    expect.objectContaining({
      baseUrl: "https://models.example.test/v1",
      apiProtocol: "chat-completions",
    }),
  );
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Models from server"]')!.click(),
  );
  await change("Search models", "found-10");
  expect([...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent)).toEqual([
    "found-10",
    "Other model…",
  ]);
  await act(async () => document.querySelector<HTMLElement>("[cmdk-item]")!.click());
  expect(document.querySelector('[aria-label="Models from server"]')?.textContent).toBe("found-10");
  await act(async () => root.unmount());
});

async function openFirstBotStep() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="/app/:botId" element={<div>Chat</div>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: false, needsSignupSurvey: false, billingEnabled: false }),
  );
  return root;
}

it("saves the chosen UI language before the first bot is created", async () => {
  setCatalogLoadersForTests(null);
  localStorage.setItem("rakazo.uiLocale", "en");
  vi.mocked(rpc.preferences.update).mockClear();
  vi.mocked(rpc.bots.create).mockClear();
  const root = await openFirstBotStep();
  await vi.waitFor(() => expect(rpc.bots.create).toHaveBeenCalled());
  expect(rpc.preferences.update).toHaveBeenCalledWith({ locale: "en" });
  const updateOrder = vi.mocked(rpc.preferences.update).mock.invocationCallOrder[0];
  const createOrder = vi.mocked(rpc.bots.create).mock.invocationCallOrder[0];
  expect(updateOrder).toBeLessThan(createOrder!);
  await act(async () => root.unmount());
  localStorage.removeItem("rakazo.uiLocale");
});

it("retries the saved language before creating the first bot after a failed save", async () => {
  setCatalogLoadersForTests(null);
  localStorage.setItem("rakazo.uiLocale", "en");
  vi.mocked(rpc.preferences.update).mockClear();
  vi.mocked(rpc.bots.create).mockClear();
  vi.mocked(rpc.preferences.update).mockRejectedValueOnce(new Error("offline"));
  const root = await openFirstBotStep();
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "Try again"),
    ).toBe(true),
  );
  expect(rpc.bots.create).not.toHaveBeenCalled();
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  await act(async () => retry!.click());
  await vi.waitFor(() => expect(rpc.bots.create).toHaveBeenCalledOnce());
  expect(rpc.preferences.update).toHaveBeenCalledTimes(2);
  expect(rpc.preferences.update).toHaveBeenLastCalledWith({ locale: "en" });
  await act(async () => root.unmount());
  localStorage.removeItem("rakazo.uiLocale");
});

it("waits for the language save to finish before creating the bot", async () => {
  const preferenceResult = await rpc.preferences.update({});
  vi.mocked(rpc.bots.create).mockClear();
  let saved!: () => void;
  vi.mocked(rpc.preferences.update).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        saved = () => resolve(preferenceResult);
      }),
  );
  const pending = ensureFirstBot();
  await vi.waitFor(() => expect(saved).toBeTypeOf("function"));
  expect(rpc.bots.create).not.toHaveBeenCalled();
  saved();
  await expect(pending).resolves.toEqual({ id: "bot-1" });
  expect(rpc.bots.create).toHaveBeenCalledOnce();
});

it("reuses an existing first bot without requiring another preference write", async () => {
  vi.mocked(rpc.preferences.update).mockClear();
  vi.mocked(rpc.bots.create).mockClear();
  vi.mocked(rpc.bots.list).mockResolvedValueOnce([
    { id: "existing", name: "Chief", spawnKey: "onboarding:first" },
  ] as never);
  await expect(ensureFirstBot()).resolves.toEqual({ id: "existing" });
  expect(rpc.preferences.update).not.toHaveBeenCalled();
  expect(rpc.bots.create).not.toHaveBeenCalled();
});
