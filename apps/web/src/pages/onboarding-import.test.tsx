// @vitest-environment jsdom
import type { AgentImportCreateInput } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OnboardingImport } from "./onboarding-import";

const { importCreate, captured } = vi.hoisted(() => ({
  importCreate: vi.fn(),
  captured: {
    createBot: undefined as undefined | ((input: AgentImportCreateInput) => Promise<unknown>),
  },
}));

vi.mock("../lib/rpc", () => ({ rpc: { bots: { importCreate } } }));
vi.mock("./shell/agent-import", () => ({
  AgentImportForm: (props: { createBot: typeof captured.createBot }) => {
    captured.createBot = props.createBot;
    return null;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("creates the imported first bot with the Nón avatar set and a seeded color", async () => {
  importCreate.mockResolvedValue({ id: "bot-1" });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <OnboardingImport
        firstBot={{
          lock: (run) => run(),
          existing: async () => undefined,
          spawnKey: "onboarding:first",
        }}
        onBack={() => {}}
        onDone={() => {}}
      />,
    );
  });

  await captured.createBot?.({ name: "Imported" } as AgentImportCreateInput);

  expect(importCreate).toHaveBeenCalledTimes(1);
  const request = importCreate.mock.calls[0]![0];
  expect(request.avatarSet).toBe("vnbot");
  expect(request.color).toMatch(/::shape_0$/);
  expect(request.spawnKey).toBe("onboarding:first");
  await act(async () => root.unmount());
});
