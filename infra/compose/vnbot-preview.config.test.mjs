import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Explicit parser-only test. Supply an official standalone Compose binary as argv[2].
// No daemon connection, containers or real credentials are used.
const parser = process.argv[2];
const root = path.resolve(import.meta.dirname, "../..");

test("preview merges into isolated ports, storage and restricted computer policy", () => {
  assert.ok(parser, "Pass the standalone Compose binary path as the test's argument");
  const work = mkdtempSync(path.join(tmpdir(), "vnbot-preview-config-"));
  try {
    const envFile = path.join(work, "preview.env");
    writeFileSync(
      envFile,
      [
        "POSTGRES_PASSWORD=offline-test-owner-password",
        "POSTGRES_APP_PASSWORD=offline-test-runtime-password",
        "SCREEN_PROXY_SECRET=offline-test-screen-secret",
        "SANDBOX_SUPERVISOR_TOKEN=offline-test-supervisor-token",
        // These must not reopen ports or mount host folders in the preview.
        "RAKAZO_WEB_BIND=0.0.0.0",
        "SANDBOX_COMPUTER_EGRESS=open",
        "SANDBOX_COMPUTER_MOUNTS=/fake-host:/mnt/host:rw",
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = spawnSync(
      path.resolve(parser),
      [
        "--project-name",
        "vnbot-040-preview",
        "--env-file",
        envFile,
        "-f",
        path.join(root, "infra/compose/docker-compose.yml"),
        "-f",
        path.join(root, "infra/compose/docker-compose.vnbot-preview.yml"),
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, "Compose must accept the merged preview configuration");
    const config = JSON.parse(result.stdout);
    assert.equal(config.name, "vnbot-040-preview");
    const services = config.services;
    // Compose 2.24 emits KEY=value arrays; later versions emit mappings.
    for (const service of Object.values(services)) {
      if (Array.isArray(service.environment)) {
        service.environment = Object.fromEntries(
          service.environment.map((entry) => {
            const separator = entry.indexOf("=");
            return separator < 0
              ? [entry, null]
              : [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
        );
      }
    }
    assert.deepEqual(Object.keys(services).sort(), [
      "api",
      "computer",
      "data-init",
      "migrate",
      "postgres",
      "supervisor",
      "web",
      "worker",
    ]);
    for (const [name, service] of Object.entries(services)) {
      if (name !== "web") assert.equal(service.ports?.length ?? 0, 0, name);
      const binds = (service.volumes ?? []).filter((volume) => volume.type === "bind");
      assert.equal(binds.length, name === "supervisor" ? 1 : 0, name);
      if (name === "supervisor") assert.equal(binds[0].source, "/var/run/docker.sock");
    }
    assert.equal(services.web.ports.length, 1);
    assert.equal(services.web.ports[0].host_ip, "127.0.0.1");
    assert.equal(services.web.ports[0].published, "54173");
    assert.equal(services.web.ports[0].target, 5173);
    for (const name of ["api", "worker", "supervisor", "data-init"]) {
      assert.ok(
        services[name].volumes.some(
          (volume) => volume.source === "preview-data" && volume.target === "/data",
        ),
        name,
      );
    }
    for (const volume of Object.values(config.volumes)) {
      assert.ok(volume.name.startsWith("vnbot-040-preview_"));
      assert.ok(!volume.external);
    }
    assert.equal(services.api.environment.API_PORT, "3100");
    assert.equal(services.api.environment.WEB_ORIGIN, "http://127.0.0.1:54173");
    assert.equal(services.supervisor.environment.SANDBOX_COMPUTER_EGRESS, "restricted");
    assert.equal(services.supervisor.environment.SANDBOX_COMPUTER_MOUNTS, "");
    assert.equal(services.computer.image, "vnbot/computer:040-preview");
    assert.equal(services.supervisor.environment.RAKAZO_COMPUTER_IMAGE, services.computer.image);
    for (const name of ["api", "worker", "postgres", "supervisor", "web"]) {
      assert.ok(services[name].healthcheck?.test?.length, name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
