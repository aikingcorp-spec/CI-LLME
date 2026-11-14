// @vitest-environment jsdom

import type { ServerUpdateCheck, ServerUpdateStatus } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));

vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SectionHeading: ({ children }: { children?: ReactNode }) => <h3>{children}</h3>,
}));

const { status, check, apply } = vi.hoisted(() => ({
  status: vi.fn(),
  check: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("../lib/rpc", () => ({
  rpc: { updater: { status, check, apply } },
}));

import { ServerUpdateSection } from "./ServerUpdateSection";

const manual =
  "Download a newer VNBot package from the place you installed this one, then start it again.";

function installed(overrides: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus {
  return {
    supported: false,
    unsupportedReason: null,
    installKind: "source",
    manualCommands: [manual],
    mode: "unavailable",
    strategy: null,
    strategyNote: null,
    version: "",
    revision: "abc1234def89",
    commit: "abc1234def89",
    branch: null,
    remoteUrl: null,
    dirty: false,
    dirtyPaths: [],
    image: null,
    imageTag: null,
    previousImageTag: null,
    canRollback: false,
    source: { repoUrl: "", branch: "", official: false },
    officialRepoUrl: "",
    restartSupervisor: "none",
    restartAdvice: "",
    running: false,
    lastRun: null,
    ...overrides,
  };
}

function unavailable(reason: string): ServerUpdateCheck {
  return {
    status: "unavailable",
    reason,
    changed: [],
    commit: null,
    targetCommit: null,
    targetTag: null,
    behindBy: 0,
  };
}

async function render() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ServerUpdateSection />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

function text(container: HTMLElement) {
  return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function button(container: HTMLElement, label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}

afterEach(() => {
  status.mockReset();
  check.mockReset();
  apply.mockReset();
  vi.unstubAllGlobals();
});

it("does not ask the server while the desktop bridge owns updates", async () => {
  vi.stubGlobal("rakazoDesktop", { update: { state: vi.fn() } });
  const { container, cleanup } = await render();
  try {
    expect(text(container)).toBe("");
    expect(status).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

it("shows the installed build and does not call a missing feed up to date", async () => {
  status.mockResolvedValue(installed());
  check.mockResolvedValue(unavailable("unconfigured"));
  const { container, cleanup } = await render();
  try {
    expect(text(container)).toContain("Build abc1234def89");
    expect(text(container)).toContain(manual);
    expect(text(container)).not.toContain("Up to date");
    expect(text(container)).not.toContain("Update");
    await act(async () => {
      button(container, "Check for updates").click();
      button(container, "Check for updates").click();
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(text(container)).not.toContain("Up to date");
    expect(text(container)).toContain(manual);
  } finally {
    await cleanup();
  }
});

it("says when the latest release cannot be read", async () => {
  status.mockResolvedValue(installed({ revision: null, commit: null, manualCommands: [] }));
  check.mockResolvedValue(unavailable("no-release"));
  const { container, cleanup } = await render();
  try {
    expect(text(container)).toContain("Installed version unavailable");
    await act(async () => {
      button(container, "Check for updates").click();
    });
    expect(text(container)).toContain("No release could be read.");
    expect(text(container)).not.toContain("Up to date");
  } finally {
    await cleanup();
  }
});

it("shows an update action only after a connected check names one", async () => {
  status.mockResolvedValue(
    installed({
      supported: true,
      mode: "sidecar",
      installKind: "sidecar",
      version: "1.2.3",
      manualCommands: [],
    }),
  );
  check
    .mockResolvedValueOnce({
      status: "available",
      reason: null,
      changed: [],
      commit: null,
      targetCommit: null,
      targetTag: "v9",
      behindBy: 1,
    })
    .mockResolvedValueOnce({
      status: "up-to-date",
      reason: null,
      changed: [],
      commit: null,
      targetCommit: null,
      targetTag: null,
      behindBy: 0,
    });
  apply.mockResolvedValue({});
  const { container, cleanup } = await render();
  try {
    expect(text(container)).toContain("v1.2.3");
    expect(text(container)).not.toContain("Up to date");
    await act(async () => {
      button(container, "Check for updates").click();
    });
    expect(text(container)).toContain("Version v9 is available.");
    await act(async () => {
      button(container, "Update").click();
      button(container, "Update").click();
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(text(container)).toContain("Up to date");
  } finally {
    await cleanup();
  }
});

it("tells a member that only the owner can check", async () => {
  status.mockRejectedValue({ code: "FORBIDDEN" });
  const { container, cleanup } = await render();
  try {
    expect(text(container)).toContain("Only the owner of this installation can check for updates.");
    expect(container.querySelector("button")).toBeNull();
    expect(check).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});

it("says the release could not be read when the server cannot be reached", async () => {
  status.mockRejectedValue(new TypeError("Failed to fetch"));
  const { container, cleanup } = await render();
  try {
    expect(text(container)).toContain("Offline. The latest release could not be read.");
    expect(text(container)).not.toContain("Up to date");
    expect(text(container)).not.toContain("Failed to fetch");
  } finally {
    await cleanup();
  }
});

it("hides a path from an error and keeps the detail closed until asked", async () => {
  status.mockResolvedValue(installed({ revision: null, commit: null }));
  check.mockResolvedValue(unavailable("could not read /srv/private"));
  const { container, cleanup } = await render();
  try {
    await act(async () => {
      button(container, "Check for updates").click();
    });
    expect(text(container)).toContain("The latest release could not be read.");
    expect(text(container)).not.toContain("/srv/private");
    expect(container.querySelector("details")).toBeNull();
  } finally {
    await cleanup();
  }
});
