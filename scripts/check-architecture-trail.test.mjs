import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedLines,
  evaluate,
  loadConfig,
  matchesSensitive,
  parseNameStatus,
} from "./check-architecture-trail.mjs";

const config = loadConfig();

const entry = `
## 2026-10-28 — Example
- What changed versus baseline: the run claim fence grew.
- Why: a stale worker could commit.
- Files / modules: packages/core/src/run-state.ts
- Invariants affected: failed runs may still return to queued.
- ADR: none
- Pull request: https://github.com/aikingcorp-spec/vnbot/pull/1
`;

function run(files, extra = {}) {
  return evaluate({
    files,
    labels: extra.labels ?? [],
    body: extra.body ?? "",
    baseHasBaseline: extra.baseHasBaseline ?? true,
    config,
  });
}

test("a sensitive edit without a changelog entry fails", () => {
  const failures = run([{ path: "packages/db/prisma/schema.prisma" }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /schema\.prisma/);
  assert.match(failures[0], /CHANGELOG-ARCHITECTURE/);
});

test("a sensitive edit with a complete changelog entry passes", () => {
  const failures = run([
    { path: "packages/core/src/run-state.ts" },
    { path: config.changelog, additions: entry },
  ]);
  assert.deepEqual(failures, []);
});

test("touching the changelog file without the required fields still fails", () => {
  const failures = run([
    { path: "apps/api/src/app.ts" },
    { path: config.changelog, additions: "typo" },
  ]);
  assert.equal(failures.length, 1);
});

test("an edit under the frozen baseline fails", () => {
  const failures = run([{ path: "docs/architecture/rakazo-baseline/SYSTEM_MAP.md" }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /baseline-typo/);
});

test("the label baseline-typo allows a baseline typo", () => {
  const failures = run([{ path: "docs/architecture/rakazo-baseline/ban-do-rakazo-goc.md" }], {
    labels: ["baseline-typo"],
  });
  assert.deepEqual(failures, []);
});

test("adding the baseline when the base branch has none is the freeze, not an edit", () => {
  const failures = run([{ path: "docs/architecture/rakazo-baseline/SYSTEM_MAP.md" }], {
    baseHasBaseline: false,
  });
  assert.deepEqual(failures, []);
});

test("no-arch-change without a justification fails", () => {
  const failures = run([{ path: "packages/auth/src/index.ts" }], {
    labels: ["no-arch-change"],
    body: "Architecture-trail-justification: short",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /20 characters/);
});

test("no-arch-change with a justification passes and does not excuse a baseline edit", () => {
  const body =
    "Architecture-trail-justification: comment-only wording inside an auth error string.";
  assert.deepEqual(
    run([{ path: "packages/auth/src/index.ts" }], { labels: ["no-arch-change"], body }),
    [],
  );
  const both = run(
    [
      { path: "packages/auth/src/index.ts" },
      { path: "docs/architecture/rakazo-baseline/SYSTEM_MAP.md" },
    ],
    { labels: ["no-arch-change"], body },
  );
  assert.equal(both.length, 1);
  assert.match(both[0], /Frozen baseline/);
});

test("a docs-only path is not sensitive", () => {
  assert.equal(matchesSensitive("docs/architecture/vnbot/README.md", config.sensitive), false);
  assert.equal(matchesSensitive("packages/adapters/src/docker-sandbox.ts", config.sensitive), true);
  assert.equal(matchesSensitive("apps/api/src/routes/threads.ts", config.sensitive), true);
  assert.equal(matchesSensitive("infra/compose/docker-compose.yml", config.sensitive), true);
  assert.deepEqual(run([{ path: "apps/web/src/pages/Shell.tsx" }]), []);
});

test("git name-status and diff additions parse", () => {
  const files = parseNameStatus(
    "M\tpackages/auth/src/index.ts\nR100\tdocs/old.md\tdocs/new.md\n",
  );
  assert.deepEqual(files, [
    { path: "packages/auth/src/index.ts" },
    { path: "docs/new.md" },
  ]);
  assert.equal(addedLines("+++ b/file\n+hello\n-old\n"), "hello");
});
