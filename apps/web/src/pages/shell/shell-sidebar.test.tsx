// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopBridge } from "../../lib/desktop";
import { webP2PClient } from "../../lib/p2p-client";
import { ShellSidebarFooter } from "./shell-sidebar";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../../lib/sign-out", () => ({
  useSignOut: () => ({ signingOut: false, logOut: vi.fn() }),
}));
vi.mock("../../lib/desktop", () => ({ desktopBridge: vi.fn() }));
vi.mock("../../lib/p2p-client", () => ({ webP2PClient: vi.fn() }));
vi.mock("../../components/SidebarFooter", () => ({
  SidebarFooter: ({ onPairing }: { onPairing?: () => void }) =>
    onPairing ? (
      <button type="button" onClick={onPairing}>
        Pair a computer
      </button>
    ) : null,
}));

const navigate = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function renderFooter() {
  await act(async () =>
    root.render(
      <ShellSidebarFooter
        mini={false}
        logos={[]}
        user={undefined}
        ticketBoardEnabled={false}
        navLinks={[]}
        closeMobileSidebar={vi.fn()}
        navigate={navigate}
        openSettings={vi.fn()}
        openIntegrations={vi.fn()}
        openSkills={vi.fn()}
      />,
    ),
  );
  return host.querySelector("button");
}

it("hides the pairing entry when no gateway is configured", async () => {
  vi.mocked(webP2PClient).mockReturnValue(undefined);
  expect(await renderFooter()).toBeNull();
});

it("hides the pairing entry on desktop", async () => {
  vi.mocked(desktopBridge).mockReturnValue({} as ReturnType<typeof desktopBridge>);
  vi.mocked(webP2PClient).mockReturnValue({} as ReturnType<typeof webP2PClient>);
  expect(await renderFooter()).toBeNull();
  vi.mocked(desktopBridge).mockReturnValue(undefined);
});

it("opens pairing from the entry when a gateway is configured", async () => {
  vi.mocked(webP2PClient).mockReturnValue({} as ReturnType<typeof webP2PClient>);
  const entry = await renderFooter();
  await act(async () => entry?.click());
  expect(navigate).toHaveBeenCalledWith("/app/pairing");
});
