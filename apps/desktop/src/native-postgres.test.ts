import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapSql,
  databaseUrl,
  defaultUserDataDir,
  initdbArgs,
  NativePostgres,
  NativePostgresError,
  PG_BIN_DIR_ENV,
  postgresEnv,
  postgresPackageName,
  postgresPaths,
  resolvePostgresBinDir,
  type RunProcess,
  type RunProcessResult,
  startArgs,
  stopArgs,
  unpackedPath,
} from "./native-postgres.js";

const OK: RunProcessResult = { code: 0, stdout: "", stderr: "", timedOut: false };

describe("Windows layout", () => {
  const win = path.win32;
  const userData = "C:\\Users\\tester\\AppData\\Roaming\\VNBot";

  it("puts the app's user data under %APPDATA%", () => {
    expect(
      defaultUserDataDir({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
        homedir: "C:\\Users\\tester",
        path: win,
      }),
    ).toBe(userData);
    expect(
      defaultUserDataDir({ platform: "win32", env: {}, homedir: "C:\\Users\\tester", path: win }),
    ).toBe(userData);
  });

  it("follows XDG on Linux and Application Support on macOS", () => {
    const base = { homedir: "/home/tester", path: path.posix };
    expect(defaultUserDataDir({ ...base, platform: "linux", env: {} })).toBe(
      "/home/tester/.config/VNBot",
    );
    expect(
      defaultUserDataDir({ ...base, platform: "linux", env: { XDG_CONFIG_HOME: "/x/cfg" } }),
    ).toBe("/x/cfg/VNBot");
    expect(defaultUserDataDir({ ...base, platform: "darwin", env: {} })).toBe(
      "/home/tester/Library/Application Support/VNBot",
    );
  });

  it("uses .exe binaries and keeps the port file next to the data directory", () => {
    const paths = postgresPaths({
      userDataDir: userData,
      binDir: "C:\\Program Files\\VNBot\\resources\\pg\\bin",
      platform: "win32",
      path: win,
    });
    expect(paths.pgCtl).toBe("C:\\Program Files\\VNBot\\resources\\pg\\bin\\pg_ctl.exe");
    expect(paths.initdb.endsWith("\\initdb.exe")).toBe(true);
    expect(paths.postgres.endsWith("\\postgres.exe")).toBe(true);
    expect(paths.root).toBe(`${userData}\\pg`);
    expect(paths.dataDir).toBe(`${userData}\\pg\\data`);
    expect(paths.portFile).toBe(`${userData}\\pg\\port`);
    expect(paths.ownerPasswordFile).toBe(`${userData}\\pg\\.owner-password`);
  });

  it("has no suffix on Linux", () => {
    const paths = postgresPaths({
      userDataDir: "/home/tester/.config/VNBot",
      binDir: "/opt/pg/bin",
      platform: "linux",
      path: path.posix,
    });
    expect(paths.pgCtl).toBe("/opt/pg/bin/pg_ctl");
    expect(paths.portFile).toBe("/home/tester/.config/VNBot/pg/port");
  });

  it("names the embedded-postgres package per platform", () => {
    expect(postgresPackageName("win32", "x64")).toBe("@embedded-postgres/windows-x64");
    expect(postgresPackageName("linux", "arm64")).toBe("@embedded-postgres/linux-arm64");
    expect(postgresPackageName("darwin", "arm64")).toBe("@embedded-postgres/darwin-arm64");
  });

  it("passes only what a server needs, never the app's secrets", () => {
    const env = postgresEnv("win32", {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      DATABASE_URL: "postgres://a:b@c/d",
      BETTER_AUTH_SECRET: "secret",
    });
    expect(env).toEqual({
      LC_ALL: "C",
      LANG: "C",
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
    });
  });
});

describe("binary directory", () => {
  const base = { env: {}, platform: "linux", arch: "x64", path: path.posix };

  it("prefers the injected directory, then the environment, then the package", () => {
    const resolveModule = () => "/app/node_modules/@embedded-postgres/linux-x64/dist/index.js";
    expect(resolvePostgresBinDir({ ...base, binDir: "/inj", resolveModule })).toBe("/inj");
    expect(
      resolvePostgresBinDir({ ...base, env: { [PG_BIN_DIR_ENV]: "/from-env" }, resolveModule }),
    ).toBe("/from-env");
    expect(resolvePostgresBinDir({ ...base, resolveModule })).toBe(
      "/app/node_modules/@embedded-postgres/linux-x64/native/bin",
    );
  });

  it("finds the Windows package by its own name and path style", () => {
    const seen: string[] = [];
    const dir = resolvePostgresBinDir({
      env: {},
      platform: "win32",
      arch: "x64",
      path: path.win32,
      resolveModule: (name) => {
        seen.push(name);
        return "C:\\app\\node_modules\\@embedded-postgres\\windows-x64\\dist\\index.js";
      },
    });
    expect(seen).toEqual(["@embedded-postgres/windows-x64"]);
    expect(dir).toBe("C:\\app\\node_modules\\@embedded-postgres\\windows-x64\\native\\bin");
  });

  it("returns null when the package is not installed", () => {
    expect(
      resolvePostgresBinDir({
        ...base,
        resolveModule: () => {
          throw new Error("not found");
        },
      }),
    ).toBeNull();
  });

  it("points into app.asar.unpacked for packaged builds", () => {
    expect(unpackedPath("/opt/VNBot/resources/app.asar/node_modules/x/native/bin")).toBe(
      "/opt/VNBot/resources/app.asar.unpacked/node_modules/x/native/bin",
    );
    expect(unpackedPath("C:\\r\\app.asar\\node_modules\\x")).toBe(
      "C:\\r\\app.asar.unpacked\\node_modules\\x",
    );
  });
});

describe("command lines", () => {
  it("initializes with scram auth and a password file, never a password argument", () => {
    const args = initdbArgs({ scratchDir: "/d.initializing", ownerPasswordFile: "/pw" });
    expect(args).toContain("--pwfile=/pw");
    expect(args).toContain("--auth=scram-sha-256");
    expect(args.join(" ")).not.toMatch(/password=/i);
  });

  it("listens only on loopback, without a unix socket", () => {
    const args = startArgs({ dataDir: "/d", logFile: "/l", port: 54329 });
    expect(args.slice(0, 2)).toEqual(["start", "-D"]);
    expect(args).toContain("-w");
    expect(args.at(-1)).toBe("-c listen_addresses=127.0.0.1 -c port=54329 -c unix_socket_directories=");
    expect(args[args.indexOf("-l") + 1]).toBe("/l");
  });

  it("stops fast and waits", () => {
    expect(stopArgs("/d")).toEqual(["stop", "-D", "/d", "-m", "fast", "-w", "-t", "60"]);
  });

  it("builds URLs for the owner and the row-level-security login", () => {
    expect(databaseUrl({ role: "rakazo_app", password: "ab12", port: 5555 })).toBe(
      "postgres://rakazo_app:ab12@127.0.0.1:5555/rakazo",
    );
  });

  it("only embeds a hex password in the bootstrap statements", () => {
    expect(bootstrapSql("a".repeat(48))).toContain("CREATE ROLE rakazo_app LOGIN PASSWORD");
    expect(() => bootstrapSql("x'; DROP DATABASE rakazo; --")).toThrow();
  });
});

describe("NativePostgres lifecycle", () => {
  let userData: string;
  let binDir: string;
  let calls: Array<{ file: string; args: string[]; stdin?: string; env: NodeJS.ProcessEnv }>;

  beforeEach(async () => {
    userData = await mkdtemp(path.join(tmpdir(), "rakazo-pg-"));
    binDir = path.join(userData, "bin");
    calls = [];
  });

  afterEach(async () => {
    await rm(userData, { recursive: true, force: true });
  });

  /** Fakes pg_ctl/initdb/postgres: initdb creates PG_VERSION, status follows start/stop. */
  function fakeRun(overrides: { start?: RunProcessResult[] } = {}): RunProcess {
    let running = false;
    const startResults = [...(overrides.start ?? [])];
    return async (file, args, options) => {
      calls.push({ file, args, stdin: options.stdin, env: options.env });
      const tool = path.basename(file);
      if (tool.startsWith("initdb")) {
        const scratch = args[args.indexOf("-D") + 1] as string;
        await mkdir(scratch, { recursive: true });
        await writeFile(path.join(scratch, "PG_VERSION"), "16\n");
        return OK;
      }
      if (tool.startsWith("pg_ctl")) {
        if (args[0] === "status") return { ...OK, code: running ? 0 : 3 };
        if (args[0] === "start") {
          const result = startResults.shift() ?? OK;
          if (result.code === 0) running = true;
          return result;
        }
        if (args[0] === "stop") {
          running = false;
          return OK;
        }
      }
      return OK;
    };
  }

  function create(options: Partial<ConstructorParameters<typeof NativePostgres>[0]> = {}) {
    let next = 40000;
    return new NativePostgres({
      userDataDir: userData,
      binDir,
      env: { PATH: "/usr/bin", DATABASE_URL: "postgres://leak:leak@x/y" },
      platform: "linux",
      path: path.posix,
      getuid: () => 1000,
      exists: () => true,
      run: fakeRun(),
      allocatePort: async () => next++,
      randomHex: (bytes) => "ab".repeat(bytes),
      ...options,
    });
  }

  it("creates the cluster once, starts it on the allocated port and reports URLs", async () => {
    const pg = create();
    const endpoints = await pg.start();
    expect(endpoints.port).toBe(40000);
    expect(endpoints.databaseUrl).toBe(`postgres://rakazo_app:${"ab".repeat(24)}@127.0.0.1:40000/rakazo`);
    expect(endpoints.migrationUrl).toBe(`postgres://rakazo:${"ab".repeat(24)}@127.0.0.1:40000/rakazo`);
    expect(pg.phase()).toBe("running");
    expect(pg.running()).toEqual(endpoints);
    expect((await readFile(path.join(userData, "pg", "port"), "utf8")).trim()).toBe("40000");
    await stat(path.join(userData, "pg", "data", "PG_VERSION"));

    const bootstrap = calls.find((call) => call.args.includes("--single"));
    expect(bootstrap?.stdin).toContain("CREATE DATABASE rakazo OWNER rakazo;");
    // The scratch directory is gone: the cluster only ever shows up complete.
    await expect(stat(path.join(userData, "pg", "data.initializing"))).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("keeps the passwords private to the owner", async () => {
    await create().start();
    for (const name of [".owner-password", ".app-password", "port"]) {
      const info = await stat(path.join(userData, "pg", name));
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it("does not hand the app's environment to the server tools", async () => {
    await create().start();
    for (const call of calls) {
      expect(call.env.DATABASE_URL).toBeUndefined();
      expect(call.env.PATH).toBe("/usr/bin");
    }
  });

  it("is idempotent while starting and when already running", async () => {
    const pg = create();
    const [first, second] = await Promise.all([pg.start(), pg.start()]);
    expect(second).toBe(first);
    expect(await pg.start()).toBe(first);
    expect(calls.filter((call) => call.args[0] === "start")).toHaveLength(1);
  });

  it("reuses the cluster and passwords on the next launch", async () => {
    await create().start();
    calls.length = 0;
    const again = create();
    const endpoints = await again.start();
    expect(calls.some((call) => path.basename(call.file) === "initdb")).toBe(false);
    expect(endpoints.databaseUrl).toContain(`:${"ab".repeat(24)}@`);
  });

  it("stops a server a crashed session left running before starting its own", async () => {
    await create().start();
    // A new instance sees the previous postgres still up through the shared fake.
    const run = fakeRun();
    await run(path.join(binDir, "pg_ctl"), ["start"], { env: {}, timeoutMs: 1 });
    calls.length = 0;
    await create({ run }).start();
    const order = calls.filter((call) => path.basename(call.file) === "pg_ctl").map((c) => c.args[0]);
    expect(order).toEqual(["status", "stop", "start"]);
  });

  it("uses the Windows executable names when the platform is win32", async () => {
    const pg = create({ platform: "win32" });
    await pg.start();
    const files = [...new Set(calls.map((call) => path.basename(call.file)))].sort();
    expect(files).toEqual(["initdb.exe", "pg_ctl.exe", "postgres.exe"]);
  });

  it("retries on a port that was taken in between, and only then", async () => {
    const taken: RunProcessResult = {
      code: 1,
      stdout: "",
      stderr: "could not bind IPv4 address: Address already in use",
      timedOut: false,
    };
    const pg = create({ run: fakeRun({ start: [taken] }) });
    expect((await pg.start()).port).toBe(40001);

    const other: RunProcessResult = { ...taken, stderr: "FATAL: data directory has wrong ownership" };
    const failing = create({ run: fakeRun({ start: [other, OK] }) });
    await expect(failing.start()).rejects.toMatchObject({ code: "start-failed" });
    expect(failing.phase()).toBe("stopped");
  });

  it("does not leak server output into the error message", async () => {
    const leak: RunProcessResult = {
      code: 1,
      stdout: "",
      stderr: "/home/tester/secret/path postgres://u:p@h/db",
      timedOut: false,
    };
    const error = await create({ run: fakeRun({ start: [leak] }) })
      .start()
      .catch((caught: unknown) => caught as NativePostgresError);
    expect(error.message).toBe("The local database did not start.");
  });

  it("refuses to run as root on posix with a clear error", async () => {
    const pg = create({ getuid: () => 0 });
    const error = await pg.start().catch((caught: unknown) => caught as NativePostgresError);
    expect(error).toBeInstanceOf(NativePostgresError);
    expect(error.code).toBe("root-user");
    expect(error.message).toMatch(/administrator/);
    expect(calls).toHaveLength(0);
  });

  it("does not apply the root check on Windows", async () => {
    await expect(create({ platform: "win32", getuid: () => 0 }).start()).resolves.toBeDefined();
  });

  it("reports missing binaries without starting anything", async () => {
    const missing = create({ exists: () => false });
    await expect(missing.start()).rejects.toMatchObject({ code: "binaries-missing" });
    const unresolved = create({
      binDir: undefined,
      resolveModule: () => {
        throw new Error("nope");
      },
    });
    await expect(unresolved.start()).rejects.toMatchObject({ code: "binaries-missing" });
    expect(calls).toHaveLength(0);
  });

  it("will not invent a password for a cluster that already exists", async () => {
    await create().start();
    await rm(path.join(userData, "pg", ".owner-password"));
    await expect(create().start()).rejects.toMatchObject({ code: "credentials-missing" });
  });

  it("rebuilds a cluster that never finished initializing", async () => {
    await mkdir(path.join(userData, "pg", "data.initializing"), { recursive: true });
    await writeFile(path.join(userData, "pg", "data.initializing", "junk"), "x");
    await create().start();
    await expect(stat(path.join(userData, "pg", "data", "junk"))).rejects.toThrow();
  });

  it("stops with a fast shutdown and is quiet when nothing runs", async () => {
    const pg = create();
    await pg.stop();
    await pg.start();
    calls.length = 0;
    await pg.stop();
    expect(calls.map((call) => call.args[0])).toEqual(["status", "stop"]);
    expect(calls[1]?.args).toContain("fast");
    expect(pg.phase()).toBe("stopped");
    expect(pg.running()).toBeNull();
    await pg.stop();
  });

  it("treats stop as a no-op when the binaries were never found", async () => {
    await expect(create({ exists: () => false }).stop()).resolves.toBeUndefined();
  });
});

const REAL_BIN_DIR = process.env[PG_BIN_DIR_ENV]?.trim();

describe.runIf(Boolean(REAL_BIN_DIR) && process.platform !== "win32" && process.getuid?.() !== 0)(
  "NativePostgres against the real bundled server",
  () => {
    let userData: string;

    beforeEach(async () => {
      userData = await mkdtemp(path.join(tmpdir(), "rakazo-pg-real-"));
    });

    afterEach(async () => {
      await rm(userData, { recursive: true, force: true });
    });

    it("initializes, starts, answers SELECT 1 over TCP, restarts and stops", async () => {
      const pg = new NativePostgres({ userDataDir: userData, binDir: REAL_BIN_DIR });
      try {
        const endpoints = await pg.start();
        expect(endpoints.port).toBeGreaterThan(1023);
        await expectSelectOne(endpoints.databaseUrl);
        await expectSelectOne(endpoints.migrationUrl);
        await pg.stop();
        expect(pg.running()).toBeNull();

        // Second launch reuses the cluster and the passwords on a fresh port.
        const again = await pg.start();
        await expectSelectOne(again.databaseUrl);
      } finally {
        await pg.stop().catch(() => undefined);
      }
      await expect(connectOnce(`postgres://x:y@127.0.0.1:1/z`)).rejects.toBeDefined();
    }, 180_000);
  },
);

/** Minimal PostgreSQL wire client: startup, SCRAM-SHA-256, then `SELECT 1`, with no dependency. */
async function expectSelectOne(url: string) {
  expect(await connectOnce(url)).toBe("1");
}

async function connectOnce(url: string): Promise<string> {
  const { scramSelectOne } = await import("./native-postgres-wire.test-helper.js");
  return scramSelectOne(url);
}
