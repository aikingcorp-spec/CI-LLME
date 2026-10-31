(() => {
  const bridge = window.rakazoSetup;
  const text = window.rakazoSetupText?.strings ?? {};
  document.documentElement.dataset.platform = bridge?.platform ?? "browser";
  document.documentElement.lang = window.rakazoSetupText?.lang ?? "vi";
  document.title = text.windowTitle ?? "VNBot";
  for (const node of document.querySelectorAll("[data-text]")) {
    node.textContent = text[node.dataset.text] ?? "";
  }
  for (const [attribute, key] of [
    ["title", "title"],
    ["aria-label", "ariaLabel"],
    ["placeholder", "placeholder"],
  ]) {
    for (const node of document.querySelectorAll(`[data-${attribute}]`)) {
      node.setAttribute(attribute, text[node.dataset[key]] ?? "");
    }
  }
  const format = (template, values) =>
    template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));

  const emailForm = document.getElementById("step-email");
  const codeForm = document.getElementById("step-code");
  const accountEmail = document.getElementById("account-email");
  const accountCode = document.getElementById("account-code");
  const accountStatus = document.getElementById("account-status");
  const legacyProfileNotice = document.getElementById("legacy-profile-notice");
  const legacyProfileMessage = document.getElementById("legacy-profile-message");
  const dismissLegacyProfile = document.getElementById("dismiss-legacy-profile");
  const retryCodeButton = document.getElementById("retry-code");
  const sendCodeButton = document.getElementById("send-code");
  const verifyCodeButton = document.getElementById("verify-code");
  const resendCodeButton = document.getElementById("resend-code");
  const changeEmailButton = document.getElementById("change-email");
  const subheading = document.getElementById("subheading");
  const form = document.getElementById("setup");
  const serverUrl = document.getElementById("server-url");
  const panelNew = document.getElementById("panel-new");
  const panelExisting = document.getElementById("panel-existing");
  const stackSection = document.getElementById("stack");
  const stackPhase = document.getElementById("stack-phase");
  const stackFailure = document.getElementById("stack-failure");
  const stackFailureMessage = document.getElementById("stack-failure-message");
  const stackFailureCode = document.getElementById("stack-failure-code");
  const stackOutput = document.getElementById("stack-output");
  const stackDetail = document.getElementById("stack-detail");
  const stackDetails = document.getElementById("stack-details");
  const stackProgress = document.getElementById("stack-progress");
  const stackProgressFill = document.getElementById("stack-progress-fill");
  const stackDockerHelp = document.getElementById("stack-docker-help");
  const status = document.getElementById("status");
  const checkButton = document.getElementById("check");
  const continueButton = document.getElementById("continue");
  const quitButton = document.getElementById("quit");

  const STACK_POLL_MS = 1000;
  const PHASE_LABELS = {
    "checking-docker": text.phasePreparing,
    preparing: text.phasePreparing,
    pulling: text.phasePulling,
    starting: text.phaseStarting,
    "waiting-healthy": text.phaseWaiting,
    ready: text.phaseReady,
  };
  const TERMINAL_PHASES = new Set([
    "idle",
    "docker-missing",
    "docker-not-running",
    "ready",
    "failed",
  ]);
  const PHASE_PROGRESS = {
    "checking-docker": 0.06,
    preparing: 0.12,
    pulling: 0.2,
    starting: 0.82,
    "waiting-healthy": 0.92,
    ready: 1,
  };
  /** Docker reports bytes pulled but never a total, so the bar approaches the next phase without reaching it. */
  const PULL_SPAN = 0.6;
  const PULL_SCALE_BYTES = 1.2e9;

  const setupState = window.rakazoSetupState;
  let machine = setupState.initial();
  function dispatchMachine(event) {
    machine = setupState.transition(machine, event);
    renderMachine();
    return machine;
  }
  function renderMachine() {
    const phase = machine.phase;
    if (machine.stack !== null) {
      const visibleStack =
        (phase === "probing" || phase === "failed") && machine.stack.phase === "ready"
          ? { ...machine.stack, phase: "waiting-healthy" }
          : machine.stack;
      renderStack(visibleStack);
    }
    if (phase === "failed") {
      if (machine.stack !== null) {
        stackPhase.textContent = machine.messageVi ?? text.startFailed;
        stackPhase.setAttribute("data-tone", "error");
        setStatus("");
      } else setStatus(machine.messageVi ?? text.startFailed, "error");
      setBusy(false);
    } else if (phase === "starting" || phase === "probing" || phase === "ready") {
      setStatus("");
      setBusy(true);
    }
  }
  /** Bumped on user edits, mode switches, and new async runs; a run left behind is stale. */
  let requestGeneration = 0;
  /** Generation of the check in flight; an edit or mode switch retires it and releases its lock. */
  let activeCheck = 0;
  let stackPolling = false;
  let lastStack = null;
  let lastProgress = 0;
  let detailsOpen = false;
  /** Set when a failure opened the output; a retry closes it again, a person's own click does not. */
  let detailsOpenedByFailure = false;
  /** Resolves the poll wait early when the main process pushes a new state. */
  let wakePoll = null;

  function selectedMode() {
    const checked = form.querySelector('input[name="mode"]:checked');
    return checked === null ? "new" : checked.value;
  }

  function setStatus(message, tone) {
    status.textContent = message;
    if (tone === undefined) status.removeAttribute("data-tone");
    else status.setAttribute("data-tone", tone);
  }

  function setBusy(busy) {
    checkButton.disabled = busy;
    continueButton.disabled = busy;
  }

  function syncPanels() {
    const mode = selectedMode();
    panelNew.hidden = mode !== "new";
    panelExisting.hidden = mode !== "existing";
    checkButton.hidden = true;
    continueButton.hidden = mode === "existing";
    if (mode !== "new") continueButton.textContent = text.continue;
    setStatus("");
  }

  function isDockerPhase(phase) {
    return phase === "docker-missing" || phase === "docker-not-running";
  }

  function downloadedBytes(stack) {
    return Object.values(stack.layerBytes ?? {}).reduce((total, bytes) => total + bytes, 0);
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
    return `${Math.round(bytes)} B`;
  }

  function progressFor(stack) {
    const base = PHASE_PROGRESS[stack.phase] ?? 0;
    if (stack.phase !== "pulling") return base;
    return base + PULL_SPAN * (1 - Math.exp(-downloadedBytes(stack) / PULL_SCALE_BYTES));
  }

  function renderProgress(stack) {
    const running = stack.phase in PHASE_PROGRESS;
    stackProgress.hidden = !running;
    if (!running) {
      lastProgress = 0;
      stackProgressFill.style.width = "0%";
      return;
    }
    // A retry restarts at its phase; otherwise the bar only ever moves forward.
    lastProgress =
      stack.phase === "checking-docker"
        ? progressFor(stack)
        : Math.max(lastProgress, progressFor(stack));
    const percent = (lastProgress * 100).toFixed(1);
    stackProgressFill.style.width = `${percent}%`;
    stackProgress.setAttribute("aria-valuenow", percent);
  }

  function renderDetails(stack) {
    const bytes = stack.phase === "pulling" ? downloadedBytes(stack) : 0;
    stackDetail.textContent =
      bytes > 0 ? format(text.downloaded, { size: formatBytes(bytes) }) : "";

    // A new attempt clears the output, so drop an expansion the person did not ask for.
    if (stack.phase === "checking-docker" && detailsOpenedByFailure) {
      detailsOpen = false;
      detailsOpenedByFailure = false;
    }
    const hasOutput = stack.output.length > 0;
    // A failure asks the person to read the output, so open it for them.
    if (stack.phase === "failed" && hasOutput && !detailsOpen) {
      detailsOpen = true;
      detailsOpenedByFailure = true;
    }
    stackDetails.hidden = !hasOutput;
    stackDetails.setAttribute("aria-expanded", String(detailsOpen && hasOutput));
    stackOutput.hidden = !(detailsOpen && hasOutput);
    if (!stackOutput.hidden) {
      stackOutput.textContent = stack.output.join("\n");
      stackOutput.scrollTop = stackOutput.scrollHeight;
    }
  }

  function renderStack(stack) {
    lastStack = stack;
    const { phase } = stack;
    stackSection.hidden = phase === "idle";
    if (phase === "idle") {
      continueButton.textContent = text.continue;
      return;
    }
    const failed = isDockerPhase(phase) || phase === "failed";
    stackPhase.textContent = (failed ? stack.message : PHASE_LABELS[phase]) ?? "";
    if (failed) stackPhase.setAttribute("data-tone", "error");
    else if (phase === "ready") stackPhase.setAttribute("data-tone", "ok");
    else stackPhase.removeAttribute("data-tone");
    const failure = phase === "failed" ? stack.failure : null;
    // Stack state owns a failed start; an earlier status or a generic fallback adds no reason.
    if (phase === "failed") setStatus("");
    stackFailure.hidden = !failure || failure.messageVi === stack.message;
    stackFailureMessage.textContent = stackFailure.hidden ? "" : failure.messageVi;
    stackFailureCode.textContent = failure?.code ?? "";

    renderProgress(stack);
    renderDetails(stack);
    stackDockerHelp.hidden = !isDockerPhase(phase);

    if (isDockerPhase(phase)) continueButton.textContent = text.checkAgain;
    else if (phase === "failed") continueButton.textContent = text.retry;
    else continueButton.textContent = text.continue;
    setBusy(!TERMINAL_PHASES.has(phase));
  }

  /** Wakes on the next pushed state, and on the timer if a push is ever missed. */
  function waitForStackChange() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (wakePoll === finish) wakePoll = null;
        resolve();
      };
      wakePoll = finish;
      setTimeout(finish, STACK_POLL_MS);
    });
  }

  /**
   * Follows a start already in flight until it settles. Leaving "This computer"
   * ends the follow so the stack becoming ready never saves over that choice.
   */
  const PROBE_DEADLINE_MS = 90_000;
  async function probeLocalPage(generation) {
    const deadline = Date.now() + PROBE_DEADLINE_MS;
    let delay = 400;
    while (generation === machine.generation && machine.phase === "probing") {
      try {
        const state = await bridge.state();
        if (generation !== machine.generation) return;
        if (state === null || !state.defaultLocalUrl) throw new Error("Local address unavailable");
        const localUrl = state.defaultLocalUrl;
        const result = await bridge.test(localUrl);
        if (generation !== machine.generation) return;
        if (result.ok) {
          const saved = await bridge.save({ mode: "new", serverUrl: localUrl });
          if (generation !== machine.generation) return;
          if (saved.ok) dispatchMachine({ type: "probe-ready", generation });
          else
            dispatchMachine({
              type: "failure",
              generation,
              code: "open",
              messageVi: saved.error ?? text.saveFailed,
            });
          return;
        }
        if (Date.now() >= deadline) {
          dispatchMachine({
            type: "failure",
            generation,
            code: "probe",
            messageVi: result.error ?? text.unreachable,
          });
          return;
        }
      } catch {
        if (generation !== machine.generation) return;
        if (Date.now() >= deadline) {
          dispatchMachine({
            type: "failure",
            generation,
            code: "probe",
            messageVi: text.checkFailed,
          });
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.6, 4000);
    }
  }

  async function followStack(generation) {
    if (stackPolling) return;
    stackPolling = true;
    try {
      while (generation === machine.generation && selectedMode() === "new") {
        const stack = await bridge.stack.state();
        if (generation !== machine.generation || selectedMode() !== "new") return;
        if (stack === null) throw new Error("Setup is not active");
        dispatchMachine({ type: "stack", generation, stack });
        if (machine.phase === "probing") {
          await probeLocalPage(generation);
          return;
        }
        if (machine.phase === "failed") return;
        await waitForStackChange();
      }
    } catch {
      if (generation === machine.generation)
        dispatchMachine({
          type: "failure",
          generation,
          code: "follow",
          messageVi: text.followFailed,
        });
    } finally {
      stackPolling = false;
    }
  }

  async function runStack() {
    if (machine.phase === "starting" || machine.phase === "probing" || machine.phase === "ready")
      return;
    const generation = dispatchMachine({ type: "start" }).generation;
    try {
      const started = await bridge.stack.start();
      if (generation !== machine.generation) return;
      if (started !== null) dispatchMachine({ type: "stack", generation, stack: started });
      if (machine.phase === "failed") return;
    } catch {
      dispatchMachine({ type: "failure", generation, code: "start", messageVi: text.startFailed });
      return;
    }
    await followStack(generation);
  }

  async function check() {
    const value = serverUrl.value;
    if (value.trim() === "") {
      setStatus(text.enterAddressFirst, "error");
      return null;
    }

    const generation = ++requestGeneration;
    activeCheck = generation;
    setBusy(true);
    setStatus(text.checking);
    try {
      const result = await bridge.test(value);
      // The address or the mode changed under the test, so its result speaks for neither.
      if (generation !== requestGeneration) return result;
      if (result.ok) {
        serverUrl.value = result.url;
        setStatus(format(text.answered, { url: result.url }), "ok");
      } else {
        setStatus(result.error ?? text.unreachable, "error");
      }
      return result;
    } catch {
      if (generation === requestGeneration) {
        setStatus(text.checkFailed, "error");
      }
      return null;
    } finally {
      if (activeCheck === generation) activeCheck = 0;
      // Only the run that still owns the controls may unlock them.
      if (generation === requestGeneration) setBusy(false);
    }
  }

  form.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "mode") {
      requestGeneration++;
      machine = setupState.transition(machine, { type: "reset" });
      // The interrupted check completes stale and stays silent, so retire its lock here.
      const interruptedCheck = activeCheck !== 0;
      activeCheck = 0;
      syncPanels();
      // Unlock immediately when nothing on this mode owns the controls; followStack exits on its
      // next poll.
      if (selectedMode() !== "new" || interruptedCheck) setBusy(false);
    }
  });

  serverUrl.addEventListener("input", () => {
    // An edited address invalidates the pending check; retire it and hand the controls back so
    // its late result changes nothing.
    if (activeCheck === 0) return;
    requestGeneration++;
    activeCheck = 0;
    setStatus("");
    setBusy(false);
  });

  checkButton.addEventListener("click", () => {
    void check();
  });

  stackDetails.addEventListener("click", () => {
    detailsOpen = !detailsOpen;
    detailsOpenedByFailure = false;
    if (lastStack !== null) renderDetails(lastStack);
  });

  stackDockerHelp.addEventListener("click", (event) => {
    const link = event.target instanceof HTMLElement ? event.target.dataset.link : undefined;
    if (link) void bridge.openLink(link);
  });

  quitButton.addEventListener("click", () => {
    if (bridge === undefined) {
      window.close();
      return;
    }
    void bridge.quit();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const mode = selectedMode();
    if (mode === "new") void runStack();
    // Pairing is not available yet; there is no direct-address connection.
  });

  function showStep(step) {
    emailForm.hidden = step !== "email";
    codeForm.hidden = step !== "code";
    form.hidden = step !== "machine";
    accountStatus.hidden = step === "machine";
    setAccountStatus("");
    if (step === "email") {
      subheading.textContent = text.subheadingEmail;
      accountEmail.focus();
    } else if (step === "code") {
      subheading.textContent = format(text.subheadingCode, { email: accountEmail.value.trim() });
      accountCode.value = "";
      accountCode.focus();
    } else {
      subheading.textContent = text.subheading;
    }
  }

  function setAccountStatus(message, tone) {
    accountStatus.textContent = message;
    if (tone === undefined) accountStatus.removeAttribute("data-tone");
    else accountStatus.setAttribute("data-tone", tone);
  }

  function showAccountRetry(visible) {
    retryCodeButton.hidden = !visible;
    sendCodeButton.hidden = visible;
  }

  function setAccountBusy(busy) {
    sendCodeButton.disabled = busy;
    verifyCodeButton.disabled = busy;
    resendCodeButton.disabled = busy;
    changeEmailButton.disabled = busy;
  }

  /** Runs one account request with the buttons held; a dead bridge reads as a failed request. */
  async function accountRequest(pendingText, request) {
    setAccountBusy(true);
    setAccountStatus(pendingText);
    try {
      return await request();
    } catch {
      return { ok: false, error: text.otpFailed };
    } finally {
      setAccountBusy(false);
    }
  }

  async function sendCode(isResend) {
    showAccountRetry(false);
    const email = accountEmail.value.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      setAccountStatus(text.enterEmail, "error");
      return;
    }
    const sent = await accountRequest(text.sendingCode, () => bridge.account.sendCode(email));
    if (!sent.ok) {
      setAccountStatus(sent.error ?? text.otpFailed, "error");
      showAccountRetry(sent.kind === "unavailable");
    } else if (isResend) setAccountStatus(text.codeResent, "ok");
    else showStep("code");
  }

  async function verifyCode() {
    const code = accountCode.value;
    if (!/^\d{6}$/.test(code)) {
      setAccountStatus(text.enterCode, "error");
      return;
    }
    const email = accountEmail.value.trim();
    const verified = await accountRequest(text.verifyingCode, () =>
      bridge.account.verifyCode(email, code),
    );
    if (verified.ok) {
      showStep("machine");
      if (selectedMode() === "existing") document.getElementById("mode-existing").focus();
      else continueButton.focus();
      return;
    }
    const message = verified.error ?? text.otpFailed;
    if (verified.kind === "unavailable") {
      showStep("email");
      setAccountStatus(message, "error");
      showAccountRetry(true);
      return;
    }
    if (verified.kind === "not-invited") showStep("email");
    else {
      accountCode.value = "";
      accountCode.focus();
    }
    setAccountStatus(message, "error");
  }

  emailForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendCode(false);
  });

  codeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void verifyCode();
  });

  accountCode.addEventListener("input", () => {
    accountCode.value = accountCode.value.replace(/\D/g, "");
  });

  resendCodeButton.addEventListener("click", () => {
    void sendCode(true);
  });
  retryCodeButton.addEventListener("click", () => {
    void sendCode(false);
  });

  changeEmailButton.addEventListener("click", () => {
    showStep("email");
  });
  dismissLegacyProfile.addEventListener("click", () => {
    legacyProfileNotice.hidden = true;
    void bridge.dismissLegacyProfileNotice();
  });

  /** Pushed state keeps progress moving even when the OS throttles this window's timers. */
  function watchStack() {
    bridge.stack.onChange((stack) => {
      wakePoll?.();
      // Before sign-in there is no machine choice for a ready stack to save.
      if (form.hidden) return;
      // A follow that ended on an error restarts here instead of leaving the panel frozen;
      // hold the controls until it has rendered the state it is restarting on.
      if (!stackPolling && selectedMode() === "new") {
        if (machine.phase === "idle" && stack?.phase !== "idle") {
          const generation = dispatchMachine({ type: "start" }).generation;
          dispatchMachine({ type: "stack", generation, stack });
          if (machine.phase === "probing") void probeLocalPage(generation);
          else if (machine.phase === "starting") void followStack(generation);
        } else if (machine.phase === "starting") void followStack(machine.generation);
      }
    });
  }

  async function init() {
    if (bridge === undefined) {
      setStatus(text.bridgeUnavailable ?? "Không có cầu nối thiết lập.", "error");
      setBusy(true);
      return;
    }

    watchStack();
    // Continue needs the Cloud address and any saved choice before it can submit.
    setBusy(true);
    try {
      const state = await bridge.state();
      if (state === null) throw new Error("Setup is not active");
      if (state.legacyProfilePath) {
        legacyProfileMessage.textContent = format(text.legacyProfileNotice, {
          path: state.legacyProfilePath,
        });
        legacyProfileNotice.hidden = false;
      }
      if (state.saved !== null) {
        const { mode } = state.saved;
        const modeInput = document.querySelector(`input[name="mode"][value="${mode}"]`);
        if (modeInput !== null) modeInput.checked = true;
        if (mode === "existing") serverUrl.value = state.saved.serverUrl;
      }
      // A relaunch with the stack down starts it before this window opens; show that
      // attempt instead of the saved mode, and follow it while it is still running.
      const stack = await bridge.stack.state();
      const attached = stack !== null && stack.phase !== "idle";
      if (attached) document.getElementById("mode-new").checked = true;
      syncPanels();
      setBusy(false);
      // A running start belongs to the machine step, whoever launched it.
      if (!attached && state.verifiedEmail === null) {
        showStep("email");
        if (state.error) setAccountStatus(state.error, "error");
        return;
      }
      showStep("machine");
      if (state.error) setStatus(state.error, "error");
      if (attached) {
        const generation = dispatchMachine({ type: "start" }).generation;
        dispatchMachine({ type: "stack", generation, stack });
        if (machine.phase === "probing") void probeLocalPage(generation);
        else if (machine.phase === "starting") void followStack(generation);
      } else if (selectedMode() === "existing") {
        document.getElementById("mode-existing").focus();
      } else {
        continueButton.focus();
      }
    } catch {
      setStatus(text.setupFailed, "error");
      setBusy(true);
    }
  }

  void init();
})();
