import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

const parser = process.argv[2];
const root = path.resolve(import.meta.dirname, "../..");

test("nested preview engine has separate storage, limits and no outer socket or host namespaces", () => {
  assert.ok(parser, "Pass an official Compose parser path");
  const result = spawnSync(
    path.resolve(parser),
    [
      "--project-name",
      "vnbot-040-preview",
      "--env-file",
      "/dev/null",
      "-f",
      path.join(root, "infra/compose/docker-compose.vnbot-executor.yml"),
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", VNBOT_PREVIEW_SOURCE_DIR: "/fake-preview-source" },
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  const config = JSON.parse(result.stdout);
  assert.equal(config.name, "vnbot-040-preview");
  assert.deepEqual(Object.keys(config.services), ["executor"]);
  const service = config.services.executor;
  assert.match(service.image, /^docker:29\.6\.1-dind@sha256:[a-f0-9]{64}$/);
  assert.equal(service.privileged, true);
  assert.equal(service.cpus, 2);
  assert.ok(["3g", "3221225472"].includes(String(service.mem_limit)));
  assert.equal(service.memswap_limit, service.mem_limit);
  assert.equal(service.pids_limit, 1024);
  for (const key of ["network_mode", "pid", "ipc", "devices"])
    assert.equal(service[key], undefined, key);
  assert.deepEqual(service.entrypoint, [
    "sh",
    "/source/infra/compose/vnbot-executor-entrypoint.sh",
  ]);
  const binds = service.volumes.filter((volume) => volume.type === "bind");
  assert.equal(binds.length, 1);
  assert.equal(binds[0].source, "/fake-preview-source");
  assert.equal(binds[0].target, "/source");
  assert.equal(binds[0].read_only, true);
  assert.deepEqual(
    service.volumes
      .filter((volume) => volume.type === "volume")
      .map((volume) => volume.target)
      .sort(),
    ["/preview", "/var/lib/docker"],
  );
  assert.equal(service.ports.length, 1);
  assert.equal(service.ports[0].host_ip, "127.0.0.1");
  assert.equal(service.ports[0].published, "54173");
  for (const volume of Object.values(config.volumes)) {
    assert.ok(volume.name.startsWith("vnbot-040-preview_"));
    assert.ok(!volume.external);
  }
});
