// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

interface SessionState {
  isPending: boolean;
  data: { user: { id: string } } | null;
  error: { status: number } | null;
}

const signedIn: SessionState = { isPending: false, data: { user: { id: "user-1" } }, error: null };
const capability = vi.hoisted(() => ({
  enabled: false,
  boardLoaded: vi.fn(),
  screen: vi.fn(async () => ({ ok: true })),
  session: null as SessionState | null,
  authMounts: 0,
  shellThrows: false,
  logOut: vi.fn(),
  syncCallIdentity: vi.fn(),
  remoteEnter: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("./lib/bootstrap", () => ({
  getTicketBoardEnabled: () => capability.enabled,
  subscribeTicketBoardEnabled: () => () => {},
}));
vi.mock("./lib/auth", () => ({
  authClient: {
    useSession: () => ({ ...(capability.session ?? signedIn), refetch: vi.fn() }),
  },
}));
vi.mock("./pages/Auth", async () => {
  const { useEffect } = await import("react");
  return {
    AuthPage: ({ mode }: { mode: string }) => {
      useEffect(() => {
        capability.authMounts += 1;
      }, []);
      return <div>Auth {mode}</div>;
    },
  };
});
vi.mock("./lib/call-session", () => ({ syncCallIdentity: capability.syncCallIdentity }));
vi.mock("./lib/remote-images-preference", () => ({
  remoteImagesPreference: { use: () => false },
}));
vi.mock("./lib/performance", () => ({ markOnce: () => {}, markAfterPaint: () => {} }));
vi.mock("./lib/rpc", () => ({
  rpc: {
    analytics: { screen: capability.screen },
    remoteHosts: { enter: capability.remoteEnter },
  },
}));
vi.mock("./components/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Shell", () => ({
  ShellPage: () => {
    if (capability.shellThrows) throw new Error("Render failed");
    return <div>Shell</div>;
  },
}));
vi.mock("./lib/sign-out", () => ({
  syncLogOutFailure: vi.fn(),
  useSignOut: () => ({ signingOut: false, logOut: capability.logOut }),
}));
vi.mock("./components/call/CallLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { CallLayout: () => <Outlet /> };
});
vi.mock("./components/markdown-link-prompt", () => ({
  MarkdownLinkPrompt: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./pages/Board", () => {
  capability.boardLoaded();
  return { BoardPage: () => <div>Board page</div> };
});
vi.mock("./pages/IntegrationSetup", () => ({ IntegrationSetupPage: () => null }));
vi.mock("./pages/McpOAuthCallback", () => ({ McpOAuthCallbackPage: () => null }));

import { App } from "./App";

it.each([
  signedIn,
  { isPending: true, data: null, error: null },
  { isPending: false, data: null, error: null },
])(
  "closes the integration callback without loading the app or requiring a web session (%j)",
  async (session) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    window.history.replaceState(null, "", "/integrations/callback?status=success");
    capability.session = session;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <App />
          </MemoryRouter>,
        ),
      );
      expect(close).toHaveBeenCalledOnce();
      expect(container.textContent).toBe("You can close this window.");
      expect(container.querySelector("[data-rakazo-app-state]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      close.mockRestore();
      capability.session = null;
      window.history.replaceState(null, "", "/");
      vi.unstubAllGlobals();
    }
  },
);

it("loads the board chunk only after bootstrap enables the route", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () => (
    <MemoryRouter initialEntries={["/app/board"]}>
      <App />
    </MemoryRouter>
  );
  try {
    await act(async () => root.render(render()));
    expect(container.textContent).toBe("Shell");
    expect(capability.screen).toHaveBeenCalledExactlyOnceWith({ screen: "board", surface: "web" });
    expect(capability.boardLoaded).not.toHaveBeenCalled();
    capability.enabled = true;
    await act(async () => {
      root.render(render());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(capability.boardLoaded).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Board page");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps the sign-in page mounted while a signed-out session refetches", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (session: SessionState) => {
    capability.session = session;
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/sign-in"]}>
          <App />
        </MemoryRouter>,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  try {
    capability.authMounts = 0;
    await render({ isPending: false, data: null, error: null });
    expect(container.textContent).toBe("Auth in");
    // Better Auth refetches a null session when the tab regains focus.
    await render({ isPending: true, data: null, error: null });
    expect(container.textContent).toBe("Auth in");
    await render({ isPending: false, data: null, error: null });
    expect(container.textContent).toBe("Auth in");
    expect(capability.authMounts).toBe(1);
  } finally {
    capability.session = null;
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["throw", "reject"])(
  "keeps screen reporting failures out of the app error boundary (%s)",
  async (mode) => {
    if (mode === "throw")
      capability.screen.mockImplementationOnce(() => {
        throw new Error("analytics unavailable");
      });
    else capability.screen.mockRejectedValueOnce(new Error("analytics unavailable"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <MemoryRouter initialEntries={["/app"]}>
            <App />
          </MemoryRouter>,
        ),
      );
      expect(container.textContent).toBe("Shell");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("tells the call session who is signed in, without counting an unreachable lookup", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (session: SessionState) => {
    capability.session = session;
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/app"]}>
          <App />
        </MemoryRouter>,
      ),
    );
  };
  try {
    capability.syncCallIdentity.mockClear();
    await render(signedIn);
    expect(capability.syncCallIdentity).toHaveBeenLastCalledWith("user-1");
    await render({ isPending: false, data: null, error: { status: 503 } });
    expect(capability.syncCallIdentity).not.toHaveBeenCalledWith(null);
    await render({ isPending: false, data: { user: { id: "user-2" } }, error: null });
    expect(capability.syncCallIdentity).toHaveBeenLastCalledWith("user-2");
    await render({ isPending: false, data: null, error: null });
    expect(capability.syncCallIdentity).toHaveBeenLastCalledWith(null);
  } finally {
    capability.session = null;
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["unavailable", "failed"])("offers sign-out from the %s app fallback", async (kind) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  capability.logOut.mockClear();
  capability.shellThrows = kind === "failed";
  capability.session =
    kind === "unavailable" ? { isPending: false, data: null, error: { status: 503 } } : signedIn;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/app"]}>
          <App />
        </MemoryRouter>,
      ),
    );
    const logout = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Log out",
    );
    expect(logout).toBeDefined();
    await act(async () => logout!.click());
    expect(capability.logOut).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    capability.shellThrows = false;
    capability.session = null;
    error.mockRestore();
    vi.unstubAllGlobals();
  }
});

async function enterRemoteTicket(
  hash: string,
  failure?: "http" | "network",
  pathname = "/remote-enter",
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const assign = vi.fn();
  const fetchMock = vi.fn(async () => {
    if (failure === "network") throw new TypeError("Failed to fetch");
    return new Response("{}", { status: failure === "http" ? 401 : 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", {
    pathname,
    hash,
    search: "",
    hostname: "localhost",
    assign,
    replace: vi.fn(),
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  let text = "";
  let exit: string | null = null;
  try {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <App />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    text = container.textContent ?? "";
    exit = container.querySelector("a")?.getAttribute("href") ?? null;
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
    sessionStorage.removeItem("rakazo-remote-join");
  }
  return { assign, fetchMock, text, exit };
}

it.each(["missing", "http", "network"] as const)(
  "offers a safe way out when remote entry fails (%s)",
  async (failure) => {
    const result = await enterRemoteTicket(
      failure === "missing" ? "#ticket=&invite=token_1" : "#ticket=ticket-1&invite=token_1",
      failure === "missing" ? undefined : failure,
    );
    expect(result.assign).not.toHaveBeenCalled();
    expect(result.text).toContain("Something went wrong. Try again.");
    expect(result.text).toContain("Log out");
    expect(result.exit).toBe("/sign-in?next=%2Finvite%2Ftoken_1");
    expect(result.fetchMock).toHaveBeenCalledTimes(failure === "missing" ? 0 : 1);
  },
);

it("keeps a failed host lookup out of a sign-in redirect loop", async () => {
  capability.remoteEnter.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const result = await enterRemoteTicket(
    "#device=device_1&invite=token_1",
    undefined,
    "/remote-join",
  );
  expect(result.assign).not.toHaveBeenCalled();
  expect(result.text).toContain("Something went wrong. Try again.");
  expect(result.exit).toBe("/sign-in?next=%2Fremote-join");
});

it("asks for sign-in when the host lookup rejects the session", async () => {
  capability.remoteEnter.mockRejectedValueOnce({ code: "UNAUTHORIZED" });
  const result = await enterRemoteTicket(
    "#device=device_1&invite=token_1",
    undefined,
    "/remote-join",
  );
  expect(result.assign).toHaveBeenCalledWith("/sign-in?next=%2Fremote-join");
});

it("keeps an incomplete host handoff from becoming a blank page", async () => {
  const result = await enterRemoteTicket("#invite=token_1", undefined, "/remote-join");
  expect(result.assign).not.toHaveBeenCalled();
  expect(result.text).toContain("Something went wrong. Try again.");
});

it("opens the invite after a remote ticket instead of the home app", async () => {
  const { assign, fetchMock } = await enterRemoteTicket("#ticket=ticket-1&invite=token_1");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/auth/remote-enter",
    expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ ticket: "ticket-1", invite: "token_1" }),
    }),
  );
  expect(assign).toHaveBeenCalledWith("/invite/token_1");
});

it.each(["#ticket=ticket-1", "#ticket=ticket-1&invite=../app"])(
  "stays in the app when a remote ticket has no usable invite (%s)",
  async (hash) => {
    const { assign } = await enterRemoteTicket(hash);
    expect(assign).toHaveBeenCalledWith("/app");
  },
);
