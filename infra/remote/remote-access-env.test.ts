import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const script = path.join(import.meta.dirname, "remote-access-env.sh");
const token = "staging-token-value-not-real";
const account = "a".repeat(32);
const zone = "b".repeat(32);

async function layout(mode: number) {
  const root = await mkdtemp(path.join(tmpdir(), "remote-env-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const staging = path.join(root, "remote-staging.env");
  const central = path.join(root, "central-remote.env");
  const args = path.join(root, "curl-args");
  await writeFile(
    path.join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${args}"
printf '%s' '{"success":true,"result":[{"id":"${zone}","name":"staging.example.test"}],"result_info":{"total_pages":1}}'
`,
  );
  await chmod(path.join(bin, "curl"), 0o755);
  await writeFile(
    staging,
    `CLOUDFLARE_ACCOUNT_ID=${account}\nCLOUDFLARE_ZONE_ID=${zone}\nCLOUDFLARE_API_TOKEN=${token}\n`,
  );
  await chmod(staging, mode);
  return { root, bin, staging, central, args };
}

it("refuses a group-readable secret and does not call the api", async () => {
  const dir = await layout(0o640);
  try {
    await expect(
      exec(script, ["check"], {
        env: {
          ...process.env,
          PATH: `${dir.bin}:${process.env.PATH}`,
          REMOTE_STAGING_FILE: dir.staging,
          REMOTE_CENTRAL_FILE: dir.central,
        },
      }),
    ).rejects.toThrow(/group or others/);
    await expect(stat(dir.args)).rejects.toThrow();
  } finally {
    await rm(dir.root, { recursive: true, force: true });
  }
});

it("writes a private central file for a zone that is not production", async () => {
  const dir = await layout(0o600);
  try {
    const checked = await exec(script, ["check"], {
      env: {
        ...process.env,
        PATH: `${dir.bin}:${process.env.PATH}`,
        REMOTE_STAGING_FILE: dir.staging,
        REMOTE_CENTRAL_FILE: dir.central,
      },
    });
    expect(checked.stdout).toContain("Remote zone: staging.example.test");
    expect(checked.stdout).not.toContain(token);
    const installed = await exec(script, ["install"], {
      env: {
        ...process.env,
        PATH: `${dir.bin}:${process.env.PATH}`,
        REMOTE_STAGING_FILE: dir.staging,
        REMOTE_CENTRAL_FILE: dir.central,
      },
    });
    expect(installed.stdout).not.toContain(token);
    const written = await readFile(dir.central, "utf8");
    expect(written).toContain("RAKAZO_REMOTE_ACCESS=");
    expect(written).toContain('"nameSuffix":"staging.example.test"');
    expect(written).toContain(token);
    expect(written).not.toContain("vnbot.run");
    expect((await stat(dir.central)).mode & 0o777).toBe(0o600);
    const argv = await readFile(dir.args, "utf8");
    expect(argv).not.toContain(token);
    expect(argv).toContain("/zones?per_page=50");
  } finally {
    await rm(dir.root, { recursive: true, force: true });
  }
});

it("blocks a token that can see the production zone and writes nothing", async () => {
  const dir = await layout(0o600);
  await writeFile(
    path.join(dir.bin, "curl"),
    `#!/bin/sh
printf '%s' '{"success":true,"result":[{"id":"${zone}","name":"vnbot.run"}],"result_info":{"total_pages":1}}'
`,
  );
  await chmod(path.join(dir.bin, "curl"), 0o755);
  try {
    await expect(
      exec(script, ["install"], {
        env: {
          ...process.env,
          PATH: `${dir.bin}:${process.env.PATH}`,
          REMOTE_STAGING_FILE: dir.staging,
          REMOTE_CENTRAL_FILE: dir.central,
        },
      }),
    ).rejects.toThrow(/production zone/);
    await expect(stat(dir.central)).rejects.toThrow();
  } finally {
    await rm(dir.root, { recursive: true, force: true });
  }
});
