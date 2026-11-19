import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { serverLog, windowsCommandLine } from "./native-process.js";

it("quotes server options with spaces, cmd metacharacters, or empty values for pg_ctl", () => {
  expect(
    windowsCommandLine([
      "-h",
      "127.0.0.1",
      "-p",
      "54321",
      "-c",
      "unix_socket_directories=",
      "-c",
      "dynamic_library_path=C:\\Users\\Thu Anh\\AppData\\Roaming\\VNBot\\native\\pg\\lib",
    ]),
  ).toBe(
    '-h 127.0.0.1 -p 54321 -c "unix_socket_directories=" -c "dynamic_library_path=C:\\Users\\Thu Anh\\AppData\\Roaming\\VNBot\\native\\pg\\lib"',
  );

  expect(
    windowsCommandLine([
      "-c",
      "dynamic_library_path=C:\\Users\\A&B\\AppData\\Local\\Programs\\vnbot\\resources\\native\\pg\\lib",
    ]),
  ).toBe(
    '-c "dynamic_library_path=C:\\Users\\A&B\\AppData\\Local\\Programs\\vnbot\\resources\\native\\pg\\lib"',
  );

  expect(windowsCommandLine(["A&B", "C(x86)", "dir\\"])).toBe('"A&B" "C(x86)" dir\\');
  expect(windowsCommandLine(["A&B\\"])).toBe('"A&B\\\\"');
});

it("logs beside a server log this account cannot replace instead of refusing to start", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vnbot-server-log-"));
  try {
    const usable = path.join(root, "postgres-server.log");
    expect(serverLog(usable)).toBe(usable);
    const blocked = path.join(root, "blocked", "postgres-server.log");
    await mkdir(blocked, { recursive: true });
    expect(serverLog(blocked)).toBe(
      path.join(root, "blocked", `postgres-server-${process.pid}.log`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
