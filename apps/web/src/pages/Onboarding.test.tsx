// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingPage } from "./Onboarding";

const rpcMock = vi.hoisted(() => ({
  me: vi.fn(),
  models: { list: vi.fn() },
  bots: { list: vi.fn(), create: vi.fn() },
  onboarding: { start: vi.fn(), promptFocus: vi.fn() },
}));

vi.mock("../lib/rpc", () => ({ rpc: rpcMock }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce(
      (text, part, index) => `${text}${index > 0 ? String(values[index - 1]) : ""}${part}`,
      "",
    );
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});
vi.mock("../components/SignupSurvey", () => ({ SignupSurvey: () => null }));
vi.mock("./onboarding-import", () => ({ OnboardingImport: () => null }));

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(path: string) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

function button(name: string) {
  return [...host.querySelectorAll("button")].find((el) => el.textContent === name);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  rpcMock.me.mockResolvedValue({ needsModel: true, needsSignupSurvey: false });
  rpcMock.models.list.mockResolvedValue([]);
  rpcMock.bots.list.mockResolvedValue([]);
  rpcMock.bots.create.mockResolvedValue({ id: "bot-1" });
  rpcMock.onboarding.start.mockResolvedValue(undefined);
  rpcMock.onboarding.promptFocus.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

it("lets a person skip the model step and still opens a first bot with the Nón look", async () => {
  await render("/onboarding/model");
  const skip = button("Skip for now");
  expect(skip).toBeDefined();
  expect(button("Continue")?.disabled).toBe(true);

  await act(async () => skip!.click());

  expect(rpcMock.bots.create).toHaveBeenCalledTimes(1);
  const input = rpcMock.bots.create.mock.calls[0]![0];
  expect(input).toMatchObject({ name: "Chief", avatarSet: "vnbot" });
  expect(input.color).toMatch(/::shape_\d+$/);
  expect(rpcMock.onboarding.start).toHaveBeenCalledWith({ botId: "bot-1" });
  expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/app/bot-1");
});
