// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DesktopLocalStackState,
  DesktopReachability,
  DesktopSetup,
  DesktopSetupState,
  RakazoSetup,
} from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Locale } from "./strings.js";
import { format, stringsFor } from "./strings.js";

const DEFAULT_LOCAL_URL = "http://127.0.0.1:6130";
const CLOUD_URL = "https://cloud.rakazo.example";

// The jsdom environment replaces the global URL, so resolve the sibling files via Node's.
const srcDir = path.dirname(fileURLToPath(import.meta.url));
const setupBody = readFileSync(path.join(srcDir, "setup.html"), "utf8").match(
  /<body>([\s\S]*)<\/body>/,
)?.[1];
const setupScript = readFileSync(path.join(srcDir, "setup.js"), "utf8");

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stackState(phase: DesktopLocalStackState["phase"]): DesktopLocalStackState {
  return { phase, message: null, output: [], layerBytes: {}, imageTag: "v0.0.0" };
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`setup.html is missing #${id}`);
  return node as T;
}

/** Pumps the microtask queue so the script's await chains advance without timers. */
async function flush(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

function selectMode(mode: "new" | "existing"): void {
  const input = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${mode}"]`);
  if (input === null) throw new Error(`setup.html is missing the ${mode} mode input`);
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function submitForm(): void {
  element<HTMLFormElement>("setup").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

interface Harness {
  /** The oldest pending `test` call's deferred, for settling one check by handle. */
  nextCheck: () => Deferred<DesktopReachability>;
  /** Resolves the oldest pending `test` call, in call order. */
  resolveCheck: (result: DesktopReachability) => void;
  /** The one `stack.start` call this mount can receive. */
  startResult: Deferred<DesktopLocalStackState>;
  /** Resolves the oldest pending `state` call, in call order. */
  resolveAppState: (saved: DesktopSetup | null) => void;
  /** Resolves the oldest pending `stack.state` call, in call order. */
  resolveStackState: (state: DesktopLocalStackState) => void;
  /** Delivers a pushed stack state the way the `desktop.setup.stack.changed` push does. */
  pushStackState: (state: DesktopLocalStackState) => void;
  /** Payloads received by `save`. */
  saves: DesktopSetup[];
  /** Addresses received by `account.sendCode`. */
  codesSent: string[];
  /** The oldest pending `account.sendCode` call. */
  nextSend: () => Deferred<{ ok: boolean; error?: string }>;
  /** The oldest pending `account.verifyCode` call. */
  nextVerify: () => Deferred<{ ok: boolean; email?: string; error?: string; kind?: string }>;
}

interface MountOptions {
  /** Who already passed the code; `null` starts on the email step. */
  verifiedEmail?: string | null;
  error?: string;
}

function mount(
  saved: DesktopSetup | null,
  locale: Locale = "vi",
  options: MountOptions = {},
): Harness {
  const verifiedEmail =
    options.verifiedEmail === undefined ? "lan@vnbot.vn" : options.verifiedEmail;
  document.body.innerHTML = setupBody ?? "";
  const checkCalls: Array<Deferred<DesktopReachability>> = [];
  const startResult = deferred<DesktopLocalStackState>();
  const stateCalls: Array<Deferred<DesktopSetupState>> = [];
  const stackStateCalls: Array<Deferred<DesktopLocalStackState>> = [];
  const pushListeners: Array<(state: DesktopLocalStackState) => void> = [];
  const saves: DesktopSetup[] = [];
  const codesSent: string[] = [];
  const sendCalls: Array<Deferred<{ ok: boolean; error?: string }>> = [];
  const verifyCalls: Array<
    Deferred<{ ok: boolean; email?: string; error?: string; kind?: string }>
  > = [];

  const bridge: RakazoSetup = {
    platform: "linux",
    state: () => {
      const call = deferred<DesktopSetupState>();
      stateCalls.push(call);
      return call.promise;
    },
    test: () => {
      const call = deferred<DesktopReachability>();
      checkCalls.push(call);
      return call.promise;
    },
    save: (setup) => {
      saves.push(setup);
      return Promise.resolve({ ok: true });
    },
    account: {
      sendCode: (email) => {
        codesSent.push(email);
        const call = deferred<{ ok: boolean; error?: string }>();
        sendCalls.push(call);
        return call.promise;
      },
      verifyCode: () => {
        const call = deferred<{ ok: boolean; email?: string; error?: string; kind?: string }>();
        verifyCalls.push(call);
        return call.promise;
      },
    },
    quit: () => Promise.resolve(),
    openLink: () => Promise.resolve(),
    stack: {
      state: () => {
        const call = deferred<DesktopLocalStackState>();
        stackStateCalls.push(call);
        return call.promise;
      },
      start: () => startResult.promise,
      onChange: (listener) => {
        pushListeners.push(listener);
      },
    },
  };
  (window as { rakazoSetup?: RakazoSetup }).rakazoSetup = bridge;
  (window as { rakazoSetupText?: unknown }).rakazoSetupText = {
    lang: locale,
    strings: stringsFor(locale).setup,
  };
  // Run the plain script the same way setup.html's script tag does.
  new Function(setupScript)();

  const initState = stateCalls.shift();
  initState?.resolve({
    defaultLocalUrl: DEFAULT_LOCAL_URL,
    cloudUrl: CLOUD_URL,
    saved,
    verifiedEmail,
    error: options.error,
  });
  return {
    nextCheck: () => {
      const call = checkCalls.shift();
      if (call === undefined) throw new Error("no connection check is pending");
      return call;
    },
    resolveCheck: (result) => checkCalls.shift()?.resolve(result),
    startResult,
    resolveAppState: (next) =>
      stateCalls.shift()?.resolve({
        defaultLocalUrl: DEFAULT_LOCAL_URL,
        cloudUrl: CLOUD_URL,
        saved: next,
        verifiedEmail,
      }),
    resolveStackState: (state) => stackStateCalls.shift()?.resolve(state),
    pushStackState: (state) => {
      for (const listener of pushListeners) listener(state);
    },
    saves,
    codesSent,
    nextSend: () => {
      const call = sendCalls.shift();
      if (call === undefined) throw new Error("no send is pending");
      return call;
    },
    nextVerify: () => {
      const call = verifyCalls.shift();
      if (call === undefined) throw new Error("no verify is pending");
      return call;
    },
  };
}

/** Loads the page and lets init settle on an idle stack. */
async function boot(
  saved: DesktopSetup | null,
  locale: Locale = "vi",
  options: MountOptions = {},
): Promise<Harness> {
  const ui = mount(saved, locale, options);
  await flush(); // init reaches its stack.state call only after its state await resumes
  ui.resolveStackState(stackState("idle"));
  await flush();
  expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  return ui;
}

const text = stringsFor("vi").setup;

describe("setup", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete (window as { rakazoSetup?: RakazoSetup }).rakazoSetup;
    delete (window as { rakazoSetupText?: unknown }).rakazoSetupText;
  });

  it("keeps an address edited while the connection check is pending", async () => {
    const ui = await boot({ mode: "existing", serverUrl: "https://one.example" });
    element<HTMLButtonElement>("check").click();
    await flush();
    expect(element("status").textContent).toBe(text.checking);

    element<HTMLInputElement>("server-url").value = "https://two.example";
    element<HTMLInputElement>("server-url").dispatchEvent(new Event("input"));
    ui.resolveCheck({ ok: true, url: "https://normalized.example" });
    await flush();

    expect(element<HTMLInputElement>("server-url").value).toBe("https://two.example");
    expect(element("status").textContent).toBe("");
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
  });

  it("keeps a newer check busy when a stale check settles after it starts", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    const field = element<HTMLInputElement>("server-url");
    field.value = "one.example";
    element<HTMLButtonElement>("check").click();
    const staleCheck = ui.nextCheck();
    await flush();

    field.value = "two.example";
    field.dispatchEvent(new Event("input"));
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);

    element<HTMLButtonElement>("check").click();
    const currentCheck = ui.nextCheck();
    await flush();
    expect(element<HTMLButtonElement>("check").disabled).toBe(true);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);
    expect(element("status").textContent).toBe(text.checking);

    // The retired check settles last; its stale success must not touch the newer check's state.
    staleCheck.resolve({ ok: true, url: "https://one.example" });
    await flush();
    expect(field.value).toBe("two.example");
    expect(element("status").textContent).toBe(text.checking);
    expect(element<HTMLButtonElement>("check").disabled).toBe(true);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);

    currentCheck.resolve({ ok: true, url: "https://two.example" });
    await flush();
    expect(field.value).toBe("https://two.example");
    expect(element("status").textContent).toBe(
      format(text.answered, { url: "https://two.example" }),
    );
    expect(element("status").getAttribute("data-tone")).toBe("ok");
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("ignores a start that finishes after leaving This computer", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);

    selectMode("existing");
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);

    ui.startResult.resolve(stackState("starting"));
    await flush();
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
    expect(element("stack").hidden).toBe(true);
    expect(element("stack-phase").textContent).toBe("");
  });

  it("stays silent when a start fails after leaving This computer", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    await flush();
    selectMode("existing");
    await flush();

    ui.startResult.reject(new Error("renderer closed"));
    await flush();

    expect(element("status").textContent).toBe("");
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("re-attaches to the running stack after returning to This computer", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    await flush();
    selectMode("existing");
    await flush();
    ui.startResult.resolve(stackState("starting"));
    await flush();

    selectMode("new");
    await flush();
    ui.pushStackState(stackState("pulling"));
    await flush();
    ui.resolveStackState(stackState("pulling"));
    await flush();

    expect(element("stack").hidden).toBe(false);
    expect(element("stack-phase").textContent).toBe(text.phasePulling);
  });

  it("normalizes the address and reports success for the current check", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    element<HTMLInputElement>("server-url").value = "one.example";
    element<HTMLButtonElement>("check").click();
    ui.resolveCheck({ ok: true, url: "https://one.example" });
    await flush();

    expect(element<HTMLInputElement>("server-url").value).toBe("https://one.example");
    expect(element("status").textContent).toBe(
      format(text.answered, { url: "https://one.example" }),
    );
    expect(element("status").getAttribute("data-tone")).toBe("ok");
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
  });

  it("reports a failed current check", async () => {
    const ui = await boot(null);
    selectMode("existing");
    await flush();
    element<HTMLInputElement>("server-url").value = "https://down.example";
    element<HTMLButtonElement>("check").click();
    ui.resolveCheck({ ok: false, error: "Server did not answer." });
    await flush();

    expect(element("status").textContent).toBe("Server did not answer.");
    expect(element("status").getAttribute("data-tone")).toBe("error");
    expect(element<HTMLButtonElement>("check").disabled).toBe(false);
  });

  it("renders a current start and follows it until it saves the ready stack", async () => {
    const ui = await boot(null);
    selectMode("new");
    submitForm();
    ui.startResult.resolve(stackState("pulling"));
    await flush();
    expect(element("stack").hidden).toBe(false);
    expect(element("stack-phase").textContent).toBe(text.phasePulling);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(true);

    ui.resolveStackState(stackState("ready"));
    await flush();
    ui.resolveAppState(null);
    await flush();

    expect(element("stack-phase").textContent).toBe(text.phaseReady);
    expect(element("stack-phase").getAttribute("data-tone")).toBe("ok");
    expect(ui.saves).toEqual([{ mode: "new", serverUrl: DEFAULT_LOCAL_URL }]);
    expect(element<HTMLButtonElement>("continue").disabled).toBe(false);
  });

  it("renders the page in Vietnamese by default", async () => {
    await boot(null);
    expect(document.documentElement.lang).toBe("vi");
    expect(document.title).toBe(text.windowTitle);
    expect(document.querySelector(".heading")?.textContent).toBe(text.heading);
    expect(element("continue").textContent).toBe(text.continue);
    expect(element("quit").getAttribute("title")).toBe(text.quitTitle);
    expect(element("server-url").getAttribute("placeholder")).toBe("https://vnbot.example.com");
  });

  it("renders the page in English when asked", async () => {
    await boot(null, "en");
    const english = stringsFor("en").setup;
    expect(document.documentElement.lang).toBe("en");
    expect(document.querySelector(".heading")?.textContent).toBe(english.heading);
    expect(element("continue").textContent).toBe(english.continue);
    expect(element("subheading").textContent).toBe(english.subheading);
    expect(element("check").textContent).toBe(english.check);
  });

  function visibleStep(): string[] {
    return ["step-email", "step-code", "setup"].filter((id) => !element(id).hidden);
  }

  function submitStep(id: string): void {
    element<HTMLFormElement>(id).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  }

  /** Enters an address and answers the send request, landing on the code step. */
  async function reachCodeStep(ui: Harness): Promise<void> {
    element<HTMLInputElement>("account-email").value = " lan@vnbot.vn ";
    submitStep("step-email");
    ui.nextSend().resolve({ ok: true });
    await flush();
  }

  it("goes from email to code to machine on a first run", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    expect(visibleStep()).toEqual(["step-email"]);
    expect(element("subheading").textContent).toBe(text.subheadingEmail);
    expect(element("send-code").textContent).toBe(text.sendCode);
    expect(element("account-status").hidden).toBe(false);

    await reachCodeStep(ui);
    expect(ui.codesSent).toEqual(["lan@vnbot.vn"]);
    expect(visibleStep()).toEqual(["step-code"]);
    expect(element("subheading").textContent).toBe(
      format(text.subheadingCode, { email: "lan@vnbot.vn" }),
    );
    expect(element("verify-code").textContent).toBe(text.verifyCode);
    expect(element("resend-code").textContent).toBe(text.resendCode);
    expect(element("change-email").textContent).toBe(text.changeEmail);

    element<HTMLInputElement>("account-code").value = "123456";
    submitStep("step-code");
    await flush();
    expect(element<HTMLButtonElement>("verify-code").disabled).toBe(true);
    ui.nextVerify().resolve({ ok: true, email: "lan@vnbot.vn" });
    await flush();

    expect(visibleStep()).toEqual(["setup"]);
    expect(element("subheading").textContent).toBe(text.subheading);
    expect(element("account-status").hidden).toBe(true);
    expect(element<HTMLInputElement>("mode-new").checked).toBe(true);
  });

  it("starts on the machine step once this computer has a verified email", async () => {
    await boot({ mode: "existing", serverUrl: "https://one.example" });
    expect(visibleStep()).toEqual(["setup"]);
    expect(element<HTMLInputElement>("server-url").value).toBe("https://one.example");
  });

  it("shows a running start on the machine step even before sign-in", async () => {
    const ui = mount(null, "vi", { verifiedEmail: null });
    await flush();
    ui.resolveStackState(stackState("pulling"));
    await flush();
    expect(visibleStep()).toEqual(["setup"]);
    expect(element("stack-phase").textContent).toBe(text.phasePulling);
  });

  it("does not follow a pushed stack state before sign-in", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    ui.pushStackState(stackState("ready"));
    await flush();
    expect(visibleStep()).toEqual(["step-email"]);
    expect(ui.saves).toEqual([]);
  });

  it("refuses a malformed email without calling the server", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    element<HTMLInputElement>("account-email").value = "lan";
    submitStep("step-email");
    await flush();
    expect(ui.codesSent).toEqual([]);
    expect(element("account-status").textContent).toBe(text.enterEmail);
    expect(element("account-status").getAttribute("data-tone")).toBe("error");
    expect(visibleStep()).toEqual(["step-email"]);
  });

  it("stays on the email step when the code cannot be sent", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    element<HTMLInputElement>("account-email").value = "lan@vnbot.vn";
    submitStep("step-email");
    ui.nextSend().resolve({ ok: false, error: text.otpNetwork });
    await flush();
    expect(visibleStep()).toEqual(["step-email"]);
    expect(element("account-status").textContent).toBe(text.otpNetwork);
    expect(element<HTMLButtonElement>("send-code").disabled).toBe(false);
  });

  it("keeps a wrong code on the code step, clearing it", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    await reachCodeStep(ui);
    element<HTMLInputElement>("account-code").value = "123456";
    submitStep("step-code");
    ui.nextVerify().resolve({ ok: false, error: text.otpInvalid, kind: "invalid-code" });
    await flush();
    expect(visibleStep()).toEqual(["step-code"]);
    expect(element<HTMLInputElement>("account-code").value).toBe("");
    expect(element("account-status").textContent).toBe(text.otpInvalid);
  });

  it("returns a person who is not invited to the email step, with the reason", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    await reachCodeStep(ui);
    element<HTMLInputElement>("account-code").value = "123456";
    submitStep("step-code");
    ui.nextVerify().resolve({ ok: false, error: text.otpNotInvited, kind: "not-invited" });
    await flush();
    expect(visibleStep()).toEqual(["step-email"]);
    expect(element("account-status").textContent).toBe(text.otpNotInvited);
  });

  it("does not call the server for an unfinished code, and strips non-digits", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    await reachCodeStep(ui);
    const code = element<HTMLInputElement>("account-code");
    code.value = "12a3";
    code.dispatchEvent(new Event("input"));
    expect(code.value).toBe("123");
    submitStep("step-code");
    await flush();
    expect(() => ui.nextVerify()).toThrow("no verify is pending");
    expect(element("account-status").textContent).toBe(text.enterCode);
  });

  it("resends the code and can go back to change the email", async () => {
    const ui = await boot(null, "vi", { verifiedEmail: null });
    await reachCodeStep(ui);
    element<HTMLButtonElement>("resend-code").click();
    ui.nextSend().resolve({ ok: true });
    await flush();
    expect(ui.codesSent).toEqual(["lan@vnbot.vn", "lan@vnbot.vn"]);
    expect(element("account-status").textContent).toBe(text.codeResent);
    expect(visibleStep()).toEqual(["step-code"]);

    element<HTMLButtonElement>("change-email").click();
    expect(visibleStep()).toEqual(["step-email"]);
    expect(element("account-status").textContent).toBe("");
  });

  it("offers VNBot Cloud disabled with a badge, and keeps it disabled after a save", async () => {
    const ui = await boot(null);
    const cloud = element<HTMLInputElement>("mode-cloud");
    expect(cloud.disabled).toBe(true);
    expect(cloud.checked).toBe(false);
    expect(cloud.closest("label")?.textContent).toContain(text.comingSoon);
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[name="mode"]')].map((i) => i.value),
    ).toEqual(["new", "existing", "cloud"]);
    expect(element<HTMLInputElement>("mode-new").checked).toBe(true);

    selectMode("existing");
    element<HTMLInputElement>("server-url").value = "https://one.example";
    submitForm();
    await flush();
    expect(ui.saves).toEqual([{ mode: "existing", serverUrl: "https://one.example" }]);
    expect(cloud.disabled).toBe(true);
    expect(element<HTMLInputElement>("mode-new").disabled).toBe(false);
  });

  it("shows a saved hosted address as the person's own machine", async () => {
    await boot({ mode: "existing", serverUrl: CLOUD_URL });
    expect(element<HTMLInputElement>("mode-existing").checked).toBe(true);
    expect(element<HTMLInputElement>("server-url").value).toBe(CLOUD_URL);
    expect(element<HTMLInputElement>("mode-cloud").checked).toBe(false);
  });

  it("has no password field in any step", () => {
    document.body.innerHTML = setupBody ?? "";
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("ships Vietnamese text in the page itself", () => {
    document.body.innerHTML = setupBody ?? "";
    for (const node of document.querySelectorAll<HTMLElement>("[data-text]")) {
      const key = node.dataset.text as keyof typeof text;
      expect(node.textContent, key).toBe(text[key]);
    }
    for (const [attribute, key] of [
      ["title", "title"],
      ["aria-label", "ariaLabel"],
      ["placeholder", "placeholder"],
    ] as const) {
      for (const node of document.querySelectorAll<HTMLElement>(`[data-${attribute}]`)) {
        const textKey = node.dataset[key] as keyof typeof text;
        expect(node.getAttribute(attribute), textKey).toBe(text[textKey]);
      }
    }
  });
});
