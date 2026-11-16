import { expect, it } from "vitest";
import { startRemoteConnector } from "./remote-connector.js";

it("starts one connector for a token, replaces it, and stops", () => {
  const children: { token: string; killed: boolean }[] = [];
  const connector = startRemoteConnector({
    executable: "cloudflared",
    spawnProcess: (_command, args) => {
      const token = args[3] ?? "";
      const child = { token, killed: false };
      children.push(child);
      return {
        kill: () => {
          child.killed = true;
        },
      };
    },
  });
  connector.adopt("run-token");
  connector.adopt("run-token");
  expect(children).toHaveLength(1);
  expect(children[0]?.token).toBe("run-token");
  expect(connector.running()).toBe(true);
  connector.adopt("next-token");
  expect(children[0]?.killed).toBe(true);
  expect(children).toHaveLength(2);
  connector.stop();
  expect(children[1]?.killed).toBe(true);
  expect(connector.running()).toBe(false);
  expect(JSON.stringify(children)).not.toContain("api-token");
});

it("marks the connector failed when it exits and starts again on the next token", () => {
  let notify: (() => void) | undefined;
  let starts = 0;
  const stopped: string[] = [];
  const connector = startRemoteConnector({
    onStop: () => stopped.push("stopped"),
    spawnProcess: () => {
      starts += 1;
      return {
        kill: () => undefined,
        onExit: (listen) => {
          notify = () => listen(1);
        },
      };
    },
  });
  connector.adopt("run-token");
  expect(connector.running()).toBe(true);
  notify?.();
  expect(connector.failed()).toBe(true);
  expect(connector.running()).toBe(false);
  expect(stopped).toEqual(["stopped"]);
  connector.adopt("run-token");
  expect(starts).toBe(2);
  expect(connector.failed()).toBe(false);
});

it("finds the connector once and starts it when found", async () => {
  const started: string[] = [];
  let find: (value: string) => void = () => undefined;
  let attempts = 0;
  const connector = startRemoteConnector({
    executable: () => {
      attempts += 1;
      return new Promise((resolve) => {
        find = resolve;
      });
    },
    spawnProcess: (command) => {
      started.push(command);
      return { kill: () => undefined };
    },
  });
  connector.adopt("run-token");
  connector.adopt("run-token");
  expect(connector.running()).toBe(true);
  find("/tools/cloudflared");
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual(["/tools/cloudflared"]);
  expect(attempts).toBe(1);
});

it("does not start a connector stopped while it was being found", async () => {
  const started: string[] = [];
  let find: (value: string) => void = () => undefined;
  const connector = startRemoteConnector({
    executable: () =>
      new Promise((resolve) => {
        find = resolve;
      }),
    spawnProcess: (command) => {
      started.push(command);
      return { kill: () => undefined };
    },
  });
  connector.adopt("run-token");
  connector.stop();
  find("/tools/cloudflared");
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([]);
});

it("marks the connector failed when it cannot be found, and looks again next time", async () => {
  const errors: unknown[] = [];
  let attempts = 0;
  const connector = startRemoteConnector({
    executable: async () => {
      attempts += 1;
      throw new Error("offline");
    },
    onError: (error) => errors.push(error),
    spawnProcess: () => ({ kill: () => undefined }),
  });
  connector.adopt("run-token");
  await new Promise((resolve) => setImmediate(resolve));
  expect(connector.failed()).toBe(true);
  expect(connector.running()).toBe(false);
  expect(errors).toHaveLength(1);
  connector.adopt("run-token");
  await new Promise((resolve) => setImmediate(resolve));
  expect(attempts).toBe(2);
});
