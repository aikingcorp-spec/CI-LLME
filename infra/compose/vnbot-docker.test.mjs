import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Runs the real launcher with offline CLI boundaries. Does not start containers.
const powershell = process.argv[2];
assert.ok(powershell, "Pass a PowerShell executable path");
const fixture = `
$global:calls = [Collections.Generic.List[object]]::new()
$global:answers = [Collections.Generic.Queue[string]]::new()
foreach ($answer in @('smtp.example.test', '465', 'owner@example.test', 'p@ss:$word', 'sender@example.test')) { $global:answers.Enqueue($answer) }
function global:Read-Host {
    param($Prompt, [switch]$AsSecureString)
    if ($Prompt -like 'Go DONG Y*') {
        if ($env:KIT_TEST_SCENARIO -eq 'cancel-repair') { return '' }
        return 'DONG Y'
    }
    if ($env:KIT_TEST_SCENARIO -eq 'no-prompts') { throw 'Unexpected configuration prompt' }
    $answer = $global:answers.Dequeue()
    if ($AsSecureString) { return ConvertTo-SecureString $answer -AsPlainText -Force }
    return $answer
}
function global:docker {
    $global:calls.Add(@($args))
    if ($env:COMPOSE_PROJECT_NAME -or $env:DOCKER_HOST -or $env:SMTP_URL) { throw 'Ambient settings leaked' }
    $global:LASTEXITCODE = 0
    $command = $args -join ' '
    if ($command -eq 'context show') { return 'desktop-linux' }
    if ($command -like 'context inspect*') {
        if ($env:KIT_TEST_SCENARIO -eq 'remote') { return 'tcp://remote.example.test:2375' }
        return 'unix:///var/run/docker.sock'
    }
    if ($command -like '*info --format*') {
        if ($command -like '*OperatingSystem*') {
            if ($env:KIT_TEST_SCENARIO -eq 'engine-linux') { return 'Debian GNU/Linux' }
            return 'Docker Desktop'
        }
        if ($env:KIT_TEST_SCENARIO -eq 'windows') { return 'windows' }
        return 'linux'
    }
    if ($command -like '*compose version*') { return 'v2.24.4' }
    if ($command -like '*config --quiet' -and $env:KIT_TEST_SCENARIO -eq 'invalid') { $global:LASTEXITCODE = 17 }
    $global:calls | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'calls.json')
    if ($command -like '*exec -T supervisor node -p*') {
        if ($env:KIT_TEST_SCENARIO -eq 'runtime-closed') { return 'restricted' }
        return 'open'
    }
}
function global:Invoke-WebRequest { return @{ StatusCode = 200 } }
function global:Start-Process { param($Target); $Target | Set-Content (Join-Path $PSScriptRoot 'browser.txt') }
$env:COMPOSE_PROJECT_NAME = 'other-project'
$env:DOCKER_HOST = 'tcp://unrelated.example.test:2375'
$env:SMTP_URL = 'ambient-must-not-be-used'
. (Join-Path $PSScriptRoot 'VNBot.ps1') -Action $env:KIT_TEST_ACTION
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($env:DOCKER_HOST -ne 'tcp://unrelated.example.test:2375') { throw 'Environment not restored' }
`;

function withKit(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "vnbot-kit-test-"));
  try {
    mkdirSync(path.join(directory, "source/infra/compose"), { recursive: true });
    copyFileSync(
      path.join(import.meta.dirname, "vnbot-docker.ps1"),
      path.join(directory, "VNBot.ps1"),
    );
    for (const name of ["docker-compose.yml", "docker-compose.vnbot-preview.yml"]) {
      copyFileSync(
        path.join(import.meta.dirname, name),
        path.join(directory, "source/infra/compose", name),
      );
    }
    writeFileSync(path.join(directory, "test.ps1"), fixture);
    run(directory, (action = "Start", scenario = "ok") =>
      spawnSync(powershell, ["-NoLogo", "-NoProfile", "-File", path.join(directory, "test.ps1")], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1",
          KIT_TEST_ACTION: action,
          KIT_TEST_SCENARIO: scenario,
        },
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("first start generates distinct keys, keeps SMTP private, waits for services and opens the local app", () => {
  withKit((directory, run) => {
    const first = run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const settings = readFileSync(path.join(directory, ".env"), "utf8");
    const keys = [
      ...settings.matchAll(
        /^(?:POSTGRES_PASSWORD|POSTGRES_APP_PASSWORD|BETTER_AUTH_SECRET|ENCRYPTION_KEY|SANDBOX_SUPERVISOR_TOKEN|SCREEN_PROXY_SECRET)='([a-f0-9]{64})'$/gm,
      ),
    ];
    assert.equal(keys.length, 6);
    assert.equal(new Set(keys.map((match) => match[1])).size, 6);
    assert.ok(
      settings.includes(
        "SMTP_URL='smtps://owner%40example.test:p%40ss%3A%24word@smtp.example.test:465'",
      ),
    );
    assert.ok(!first.stdout.includes("p%40ss"));
    assert.ok(!first.stdout.includes(keys[0][1]));
    const calls = JSON.parse(readFileSync(path.join(directory, "calls.json"), "utf8"));
    const up = calls.find((args) => args.includes("up"));
    assert.ok(up.includes("vnbot-ai-test"));
    assert.deepEqual(up.slice(-6), [
      "up",
      "--build",
      "--detach",
      "--wait",
      "--wait-timeout",
      "600",
    ]);
    assert.equal(
      readFileSync(path.join(directory, "browser.txt"), "utf8").trim(),
      "http://127.0.0.1:54173",
    );
    const second = run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(
      readFileSync(path.join(directory, ".env"), "utf8"),
      settings,
      "Restart must preserve encryption and database keys",
    );
    assert.ok(!second.stdout.includes("Cau hinh mail"));
    const stop = run("Stop");
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    const stopped = JSON.parse(readFileSync(path.join(directory, "calls.json"), "utf8"));
    assert.equal(stopped.at(-1).at(-1), "stop");
    assert.ok(!stopped.some((args) => args.includes("down") || args.includes("--volumes")));
  });
});

test("invalid Compose never starts services", () => {
  withKit((directory, run) => {
    const result = run("Start", "invalid");
    assert.equal(result.status, 1);
    const calls = JSON.parse(readFileSync(path.join(directory, "calls.json"), "utf8"));
    assert.ok(!calls.some((args) => args.includes("up")));
  });
});

for (const scenario of ["remote", "windows"]) {
  test(`refuses ${scenario} Docker before creating settings`, () => {
    withKit((directory, run) => {
      const result = run("Start", scenario);
      assert.equal(result.status, 1);
      assert.throws(() => readFileSync(path.join(directory, ".env")), { code: "ENOENT" });
    });
  });
}

test("changing mail preserves existing keys", () => {
  withKit((directory, run) => {
    assert.equal(run().status, 0);
    const before = readFileSync(path.join(directory, ".env"), "utf8");
    const changed = run("Configure");
    assert.equal(changed.status, 0, changed.stdout + changed.stderr);
    assert.equal(readFileSync(path.join(directory, ".env"), "utf8"), before);
  });
});

test("private mail starts without prompts and preserves settings after the supplied file changes", () => {
  withKit((directory, run) => {
    const mail = {
      smtpUrl: "smtps://owner%40example.test:private-test-password@smtp.example.test:465",
      from: "VNBot <owner@example.test>",
    };
    writeFileSync(path.join(directory, "mail.private.json"), JSON.stringify(mail));
    const first = run("Start", "no-prompts");
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const settings = readFileSync(path.join(directory, ".env"), "utf8");
    assert.ok(settings.includes(mail.smtpUrl));
    assert.ok(settings.includes(mail.from));
    assert.ok(!first.stdout.includes("private-test-password"));
    assert.ok(!first.stdout.includes("Cau hinh mail"));
    writeFileSync(path.join(directory, "mail.private.json"), "invalid-json");
    const second = run("Start", "no-prompts");
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.equal(readFileSync(path.join(directory, ".env"), "utf8"), settings);
  });
});

test("invalid private mail fails without printing input or starting services", () => {
  withKit((directory, run) => {
    const secret = "private-test-password";
    writeFileSync(path.join(directory, "mail.private.json"), `{"smtpUrl":"${secret}`);
    const result = run("Start", "no-prompts");
    assert.equal(result.status, 1);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.throws(() => readFileSync(path.join(directory, ".env")), { code: "ENOENT" });
    assert.throws(() => readFileSync(path.join(directory, "browser.txt")), { code: "ENOENT" });
  });
});

test("sandbox repair is explicit, keeps settings and only recreates the supervisor without a build", () => {
  withKit((directory, run) => {
    assert.equal(run().status, 0);
    const file = path.join(directory, "source/infra/compose/docker-compose.vnbot-preview.yml");
    const original = readFileSync(file, "utf8");
    const settings = readFileSync(path.join(directory, ".env"));
    const result = run("RepairSandbox");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes("mang noi bo"));
    assert.equal(
      readFileSync(file, "utf8"),
      original.replace("SANDBOX_COMPUTER_EGRESS: restricted", "SANDBOX_COMPUTER_EGRESS: open"),
    );
    assert.equal(
      readFileSync(path.join(directory, "sandbox-network.before-fix.yml"), "utf8"),
      original,
    );
    assert.ok(readFileSync(path.join(directory, ".env")).equals(settings));
    const calls = JSON.parse(readFileSync(path.join(directory, "calls.json"), "utf8"));
    const up = calls.find((args) => args.includes("up"));
    assert.deepEqual(up.slice(-8), [
      "up",
      "--detach",
      "--no-deps",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "120",
      "supervisor",
    ]);
    assert.ok(calls.at(-1).includes("exec"));
    assert.ok(
      !calls.some(
        (args) => args.includes("down") || args.includes("--build") || args.includes("--volumes"),
      ),
    );
    assert.equal(run("RepairSandbox").status, 0);
    assert.equal(
      readFileSync(path.join(directory, "sandbox-network.before-fix.yml"), "utf8"),
      original,
    );
  });
});

for (const scenario of ["cancel-repair", "engine-linux"]) {
  test(`sandbox repair does not change policy for ${scenario}`, () => {
    withKit((directory, run) => {
      assert.equal(run().status, 0);
      const file = path.join(directory, "source/infra/compose/docker-compose.vnbot-preview.yml");
      const original = readFileSync(file, "utf8");
      const result = run("RepairSandbox", scenario);
      assert.equal(result.status, scenario === "cancel-repair" ? 0 : 1);
      assert.equal(readFileSync(file, "utf8"), original);
      assert.throws(() => readFileSync(path.join(directory, "sandbox-network.before-fix.yml")), {
        code: "ENOENT",
      });
      assert.ok(!result.stdout.includes("Da ap dung mang OPEN"));
    });
  });
}

test("sandbox repair cannot report success when the running service kept the old policy", () => {
  withKit((_directory, run) => {
    assert.equal(run().status, 0);
    const result = run("RepairSandbox", "runtime-closed");
    assert.equal(result.status, 1);
    assert.ok(!result.stdout.includes("Da ap dung mang OPEN"));
  });
});
