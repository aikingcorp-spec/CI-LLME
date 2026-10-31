import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeFailure, logNativeFailure, redactDiagnostic } from "./native-diagnostics.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("redactDiagnostic", () => {
  it("strips URLs, passwords and tokens", () => {
    const text = redactDiagnostic(
      'connect postgresql://app:hunter2pw@127.0.0.1:5432/rakazo failed; password=hunter2pw token: "abc def" Authorization Bearer eyJhbGciOi.payload.sig ' +
        "key 0123456789abcdef0123456789abcdef0123456789abcdef at https://example.test/path?x=1",
    );
    expect(text).not.toMatch(/hunter2pw|eyJhbGci|0123456789abcdef|example\.test|127\.0\.0\.1/);
    expect(text).toContain("<url>");
    expect(text).toContain("password=<redacted>");
  });

  it("hides the user data directory and bounds the length", () => {
    const text = redactDiagnostic(
      `ENOENT /home/someone/.config/VNBot/pg/data ${"x ".repeat(500)}`,
      ["/home/someone/.config/VNBot"],
    );
    expect(text).toContain("<userData>/pg/data");
    expect(text).not.toContain("someone");
    expect(text.length).toBeLessThanOrEqual(401);
  });

  it("keeps short ordinary text", () => {
    expect(redactDiagnostic("Native api process exited with code 1.")).toBe(
      "Native api process exited with code 1.",
    );
  });
});

describe("describeFailure", () => {
  it("names the stage, class and cause chain", () => {
    const error = new Error("Native services could not start.", {
      cause: new TypeError("listen EADDRINUSE postgres://u:p@h/db"),
    });
    const line = describeFailure("services", error);
    expect(line).toBe(
      "stage=services Error: Native services could not start. <- TypeError: listen EADDRINUSE <url>",
    );
  });

  it("handles non-errors", () => {
    expect(describeFailure("migrate", "boom password=secret1")).toBe(
      "stage=migrate non-error: boom password=<redacted>",
    );
  });
});

describe("logNativeFailure", () => {
  it("writes a private log under logs/ and mirrors to stderr only in debug", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "vnbot-diag-"));
    dirs.push(dir);
    const lines: string[] = [];
    const now = () => new Date("2026-01-02T03:04:05.000Z");
    await logNativeFailure({
      userDataDir: dir,
      stage: "postgres",
      error: new Error(`failed in ${dir} with password=abc12345`),
      now,
      stderr: (line) => lines.push(line),
    });
    expect(lines).toEqual([]);
    await logNativeFailure({
      userDataDir: dir,
      stage: "migrate",
      error: new Error("Migration exited with code 1."),
      debug: true,
      now,
      stderr: (line) => lines.push(line),
    });
    const file = path.join(dir, "logs", "native-stack.log");
    const content = await readFile(file, "utf8");
    expect(content).toBe(
      "2026-01-02T03:04:05.000Z stage=postgres Error: failed in <userData> with password=<redacted>\n" +
        "2026-01-02T03:04:05.000Z stage=migrate Error: Migration exited with code 1.\n",
    );
    expect(lines).toEqual([
      "2026-01-02T03:04:05.000Z stage=migrate Error: Migration exited with code 1.",
    ]);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o077).toBe(0);
  });
});
