import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { serverLog, windowsCommandLine } from "./native-process.js";

it("quotes server options with spaces or empty values for the pg_ctl command line", () => {
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
