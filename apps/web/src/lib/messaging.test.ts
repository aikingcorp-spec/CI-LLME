import { expect, it } from "vitest";
import { chatAppRead, chatAppSetup, messagingConnectionControl } from "./messaging";

const settled = {
  statusReady: true,
  providers: [] as string[],
  identityProviders: [] as string[],
  installationsReady: true,
  slackInstallAvailable: false,
  slackInstallationCount: 0,
};

it("names Telegram and Slack absent only after both reads succeed with nothing mounted", () => {
  expect(chatAppSetup(chatAppRead(settled))).toEqual({ telegram: "absent", slack: "absent" });
  expect(chatAppSetup(chatAppRead({ ...settled, statusReady: false }))).toEqual({
    telegram: "unknown",
    slack: "unknown",
  });
});

it("treats a mounted Telegram bot or an existing link as ready", () => {
  expect(chatAppSetup(chatAppRead({ ...settled, providers: ["telegram"] })).telegram).toBe("ready");
  expect(chatAppSetup(chatAppRead({ ...settled, providers: ["telegram-work"] })).telegram).toBe(
    "ready",
  );
  expect(chatAppSetup(chatAppRead({ ...settled, identityProviders: ["telegram"] })).telegram).toBe(
    "ready",
  );
});

it("keeps Slack ready for install, a legacy provider, a saved workspace, or a link", () => {
  expect(chatAppSetup(chatAppRead({ ...settled, slackInstallAvailable: true })).slack).toBe(
    "ready",
  );
  expect(chatAppSetup(chatAppRead({ ...settled, providers: ["slack"] })).slack).toBe("ready");
  expect(chatAppSetup(chatAppRead({ ...settled, slackInstallationCount: 1 })).slack).toBe("ready");
  expect(chatAppSetup(chatAppRead({ ...settled, identityProviders: ["slack"] })).slack).toBe(
    "ready",
  );
});

it("does not call Slack absent when its install read has not succeeded", () => {
  const read = chatAppRead({
    ...settled,
    installationsReady: false,
    slackInstallAvailable: true,
    slackInstallationCount: 2,
    providers: ["telegram"],
  });
  expect(read.status).toBe("status-only");
  expect(chatAppSetup(read)).toEqual({ telegram: "ready", slack: "unknown" });
});

it("shows a token field only before a connection is ready, and Replace only once it is", () => {
  expect(
    messagingConnectionControl({ configured: false, state: "unconfigured", canConfigure: true }),
  ).toEqual({
    status: "unconfigured",
    showCredentialField: true,
    showRemove: false,
    showReplace: false,
  });
  expect(
    messagingConnectionControl({ configured: true, state: "starting", canConfigure: true }),
  ).toEqual({
    status: "starting",
    showCredentialField: false,
    showRemove: false,
    showReplace: false,
  });
  expect(
    messagingConnectionControl({ configured: true, state: "ready", canConfigure: true }),
  ).toEqual({
    status: "ready",
    showCredentialField: false,
    showRemove: true,
    showReplace: true,
  });
  expect(
    messagingConnectionControl({ configured: true, state: "error", canConfigure: true }),
  ).toEqual({
    status: "error",
    showCredentialField: true,
    showRemove: true,
    showReplace: false,
  });
  expect(
    messagingConnectionControl({ configured: true, state: "ready", canConfigure: false }),
  ).toEqual({
    status: "ready",
    showCredentialField: false,
    showRemove: false,
    showReplace: false,
  });
});
