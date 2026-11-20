// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import type { Bot, ComputerStatus } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("../../components/teach/TeachCaptureOverlay", () => ({ TeachCaptureOverlay: () => null }));
vi.mock("../../components/teach/TeachComputerOverlay", () => ({
  TeachComputerOverlayControl: () => null,
}));
vi.mock("../../components/teach/TeachRecordingChrome", () => ({
  TeachRecordingChrome: () => null,
  TeachStopButton: () => null,
}));

import { ComputerOverlay } from "./computer-overlay";

let container: HTMLDivElement;
let root: Root;

const bot = { id: "bot-1", name: "Ada", color: "ink", status: "idle" } as Bot;

function computer(state: ComputerStatus["state"]): ComputerStatus {
  return {
    botId: "bot-1",
    mode: "team",
    kind: "boat",
    state,
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
    terminalAvailable: false,
  };
}

async function render(
  state: ComputerStatus["state"],
  onStart = vi.fn(),
  options: {
    hasControl?: boolean;
    shared?: boolean;
    kind?: string;
    runsOnUserMachine?: boolean;
    embeddedScreenUrl?: string | null;
  } = {},
) {
  await act(async () => {
    root.render(
      <ComputerOverlay
        bot={bot}
        computer={{
          ...computer(state),
          ...(options.shared ? { shared: true } : {}),
          ...(options.kind ? { kind: options.kind } : {}),
          ...(options.runsOnUserMachine !== undefined
            ? { runsOnUserMachine: options.runsOnUserMachine }
            : {}),
        }}
        computerViewport={null}
        recordingSkill={null}
        teachBusy={false}
        hasControl={options.hasControl ?? false}
        composerRunning={false}
        sending={false}
        booting={false}
        sendError={null}
        embeddedScreenUrl={options.embeddedScreenUrl ?? null}
        screenFrameRef={() => undefined}
        computerScreenError={null}
        computerBooting={null}
        onStopTeaching={() => undefined}
        onStopRun={() => undefined}
        onRelease={async () => undefined}
        onTakeControl={() => undefined}
        onStart={onStart}
        onRefreshTeaching={async () => undefined}
        onClose={() => undefined}
      />,
    );
  });
  return onStart;
}

function startButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Start");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers Start for a stopped computer instead of a bare label", async () => {
  const onStart = await render("stopped");
  expect(container.textContent).toContain("Computer is stopped");
  await act(async () => startButton()?.click());
  expect(onStart).toHaveBeenCalledOnce();
});

it("offers Start for an asleep computer", async () => {
  await render("suspended");
  expect(container.textContent).toContain("Computer is asleep");
  expect(startButton()).toBeDefined();
});

it("says sign-ins are shared while someone in a shared space has control", async () => {
  const note = () => container.querySelector('[data-testid="computer-shared-browser"]');
  await render("running", vi.fn(), { hasControl: true, shared: true });
  expect(note()?.textContent).toBe(
    "Sites you sign in to stay signed in for everyone in this space",
  );
  await render("running", vi.fn(), { hasControl: true });
  expect(note()).toBeNull();
  await render("running", vi.fn(), { shared: true });
  expect(note()).toBeNull();
});

it("renders the live screen iframe for a native desktop computer when embeddedScreenUrl is available", async () => {
  const screenUrl = "http://127.0.0.1:4310/novnc/session/view/12345.abc/embed.html?view_only=true";
  await render("running", vi.fn(), {
    kind: "desktop",
    runsOnUserMachine: true,
    embeddedScreenUrl: screenUrl,
  });
  const iframe = container.querySelector("iframe");
  expect(iframe).not.toBeNull();
  expect(iframe?.getAttribute("src")).toBe(screenUrl);
  expect(container.textContent).not.toContain("This bot runs on this computer");
});

it("falls back to DesktopKindEmptyState for a native desktop computer without an embedded screen URL", async () => {
  await render("running", vi.fn(), {
    kind: "desktop",
    runsOnUserMachine: true,
    embeddedScreenUrl: null,
  });
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.textContent).toContain("This bot runs on this computer");
});
