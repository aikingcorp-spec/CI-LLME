/** Isolated real-browser fixture using the candidate's PostgreSQL, never production. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativePostgres } from "../src/native-postgres.js";

if (process.platform !== "darwin") throw new Error("macOS fixture only");
const resources = path.resolve(process.argv[2]!);
const root = await mkdtemp(path.join(tmpdir(), "mac-p2p-fixture-"));
const postgres = new NativePostgres({
  userDataDir: root,
  binDir: path.join(resources, "postgres", `darwin-${process.arch}`, "native/bin"),
  dbDir: path.join(resources, "server/db"),
});
try {
  const { migrationUrl } = await postgres.start();
  const suites = [
    ["--integration", "--spec=p2p-node-rpc"],
    [
      "--e2e",
      "--spec=plugin-marketplace|integration-setup|direct-mcp-integrations|mcp-oauth|integration-callback",
      "--workers=1",
    ],
  ];
  for (const suite of suites) {
    const child = spawn("pnpm", ["exec", "tsx", "packages/testkit/src/cli/harness.ts", ...suite], {
      env: { ...process.env, E2E_LOCAL_PG_ADMIN_URL: migrationUrl, P2P_TEST_BROWSER: "1" },
      stdio: "inherit",
      timeout: 600_000,
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error("macOS connectivity/marketplace fixture failed");
  }
} finally {
  await postgres.stop();
  await rm(root, { recursive: true, force: true });
}
