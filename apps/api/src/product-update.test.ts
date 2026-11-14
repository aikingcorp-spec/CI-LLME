import { createRouterClient } from "@orpc/server";
import type { ServerUpdateCheck, ServerUpdateRun } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProductUpdateProbe } from "./product-update.js";
import { installedProductStatus, serverUpdateProbeFromConfiguration } from "./product-update.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const revision = "abc1234def89";

describe("installed product status", () => {
  it("keeps a real revision and does not invent a product version", () => {
    const status = installedProductStatus(
      { revision: `  ${revision.toUpperCase()}  `, compose: false },
      null,
    );
    expect(status).toMatchObject({
      supported: false,
      installKind: "source",
      mode: "unavailable",
      version: "",
      revision,
      commit: revision,
      remoteUrl: null,
      image: null,
      officialRepoUrl: "",
      manualCommands: [
        "Download a newer VNBot package from the place you installed this one, then start it again.",
      ],
      source: { repoUrl: "", branch: "", official: false },
    });
    expect(JSON.stringify(status)).not.toMatch(/0\.1\.0|0\.4\.0|rakazo|github\.com/);
  });

  it("drops a revision that is not a commit and names a compose install without its project", () => {
    const status = installedProductStatus(
      { revision: "/srv/private/checkout", compose: true },
      null,
    );
    expect(status.revision).toBeNull();
    expect(status.commit).toBeNull();
    expect(status.installKind).toBe("compose");
    expect(status.version).toBe("");
    expect(JSON.stringify(status)).not.toContain("/srv/private");
  });

  it("marks a connected probe as the only apply path", () => {
    const status = installedProductStatus(
      { revision: null, compose: true },
      {
        check: vi.fn(),
        apply: vi.fn(),
      },
    );
    expect(status.supported).toBe(true);
    expect(status.mode).toBe("sidecar");
    expect(status.installKind).toBe("sidecar");
    expect(status.manualCommands).toEqual([]);
    expect(status.version).toBe("");
  });
});

describe("server update source", () => {
  it("does not connect a probe from the current configuration", () => {
    expect(serverUpdateProbeFromConfiguration()).toBeNull();
  });
});

const available: ServerUpdateCheck = {
  status: "available",
  reason: null,
  changed: ["/srv/private/file"],
  commit: null,
  targetCommit: "a".repeat(40),
  targetTag: "ghcr.io/elie222/rakazo/app:edge",
  behindBy: 2,
};

const run: ServerUpdateRun = {
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:01:00.000Z",
  ok: true,
  fromCommit: null,
  toCommit: "b".repeat(40),
  fromTag: null,
  toTag: "v0.4.1",
  strategy: "pull",
  repoUrl: "https://github.com/elie222/rakazo",
  branch: "main",
  restart: "recreated",
  restartAdvice: "Containers were recreated.",
  error: null,
  steps: [
    {
      id: "pull",
      label: "pull",
      ok: true,
      exitCode: 0,
      output: "/srv/private/secret",
    },
  ],
};

function clientFor(probe: ProductUpdateProbe | null, owner: boolean, legacyOwnerFlag = owner) {
  return createRouterClient(
    createRouter({
      productUpdate: probe,
      prisma: { user: { findFirst: vi.fn(async () => ({ id: "owner" })) } },
    } as unknown as RouterDeps),
    {
      context: {
        actor: {
          userId: owner ? "owner" : "member",
          spaceId: "space",
          email: "person@example.test",
          isDeploymentOwner: legacyOwnerFlag,
        },
      } as never,
    },
  );
}

describe("updater route", () => {
  it("lets the owner read a connected check without taking a repository from the request", async () => {
    const probe: ProductUpdateProbe = {
      check: vi.fn(async () => available),
      apply: vi.fn(async () => run),
    };
    const client = clientFor(probe, true);
    const checked = await client.updater.check({
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    });
    expect(probe.check).toHaveBeenCalledWith();
    expect(checked).toMatchObject({
      status: "available",
      targetTag: null,
      targetCommit: "a".repeat(40),
      changed: [],
    });
    expect(JSON.stringify(checked)).not.toMatch(/rakazo|\/srv\/private|elie222/);

    const applied = await client.updater.apply({
      repoUrl: "https://github.com/elie222/rakazo",
      branch: "main",
    });
    expect(probe.apply).toHaveBeenCalledWith();
    expect(applied.repoUrl).toBe("");
    expect(applied.branch).toBe("");
    expect(applied.steps).toEqual([]);
    expect(applied.restartAdvice).toBe("");
    expect(JSON.stringify(applied)).not.toMatch(/elie222|\/srv\/private/);
  });

  it("reports offline and a failed apply without the transport error", async () => {
    const probe: ProductUpdateProbe = {
      check: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.8");
      }),
      apply: vi.fn(async () => {
        throw new Error("failed at /srv/private token=secret");
      }),
    };
    const client = clientFor(probe, true);
    const checked = await client.updater.check({});
    expect(checked.status).toBe("unavailable");
    expect(checked.reason).toBe("offline");
    expect(JSON.stringify(checked)).not.toContain("10.0.0.8");
    await expect(client.updater.apply({})).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "The update could not be completed.",
    });
  });

  it("refuses a member even when a probe is connected", async () => {
    const probe: ProductUpdateProbe = {
      check: vi.fn(),
      apply: vi.fn(),
    };
    const client = clientFor(probe, false);
    await expect(client.updater.status()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.updater.check({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client.updater.apply({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(probe.check).not.toHaveBeenCalled();
    expect(probe.apply).not.toHaveBeenCalled();
  });

  it("turns an unnamed available release into no release", async () => {
    const probe: ProductUpdateProbe = {
      check: vi.fn(async () => ({ ...available, targetCommit: null, targetTag: "not a tag" })),
      apply: vi.fn(),
    };
    const checked = await clientFor(probe, true).updater.check({});
    expect(checked).toMatchObject({ status: "unavailable", reason: "no-release" });
    expect(probe.apply).not.toHaveBeenCalled();
  });
});

it("treats an unsuccessful updater result as a failed action", async () => {
  const client = clientFor(
    {
      check: vi.fn(),
      apply: vi.fn(async () => ({ ...run, ok: false, error: "token=secret-value" })),
    },
    true,
  );
  await expect(client.updater.apply({})).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "The update could not be completed.",
  });
});

it("does not publish free-form service diagnostics in an update result", async () => {
  const client = clientFor(
    {
      check: vi.fn(),
      apply: vi.fn(async () => ({
        ...run,
        restartAdvice: "token=secret-value",
        steps: [{ ...run.steps[0]!, label: "credential=private-value" }],
      })),
    },
    true,
  );
  const result = await client.updater.apply({});
  expect(JSON.stringify(result)).not.toMatch(/secret-value|private-value/);
});

it("allows the verified installation owner even without the legacy owner flag", async () => {
  await expect(clientFor(null, true, false).updater.check({})).resolves.toMatchObject({
    status: "unavailable",
    reason: "unconfigured",
  });
});
it("does not grant installation access from the legacy owner flag", async () => {
  await expect(clientFor(null, false, true).updater.check({})).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
