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
