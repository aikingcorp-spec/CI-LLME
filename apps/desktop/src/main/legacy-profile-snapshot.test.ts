import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { snapshotLegacyProfile } from "./legacy-profile-snapshot.js";

const fixtures: string[] = [];
afterEach(async () => {
  for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vnbot-copy-"));
  fixtures.push(root);
  const profile = path.join(root, "source");
  const destination = path.join(root, "copy");
  await mkdir(path.join(profile, "pg", "data"), { recursive: true });
  await mkdir(path.join(profile, "files"));
  await writeFile(path.join(profile, "pg", "data", "PG_VERSION"), "16\n");
  await writeFile(
    path.join(profile, "native-stack-env"),
    JSON.stringify({ ENCRYPTION_KEY: "fixture-key" }),
    { mode: 0o600 },
  );
  await writeFile(path.join(profile, "files", "chat.txt"), "preserved file");
  await writeFile(path.join(profile, "ui-locale.txt"), "vi\n");
  return { root, profile, destination, entries: ["pg", "native-stack-env", "files"] };
}
it("copies the stopped profile and returns the same verified snapshot on retry", async () => {
  const f = await fixture();
  const before = await readdir(f.profile);
  const first = await snapshotLegacyProfile(f);
  const second = await snapshotLegacyProfile(f);
  expect(second).toEqual(first);
  expect(await readdir(f.profile)).toEqual(before);
  for (const name of ["pg/data/PG_VERSION", "files/chat.txt", "native-stack-env"])
    expect(await readFile(path.join(f.destination, name))).toEqual(
      await readFile(path.join(f.profile, name)),
    );
  await expect(readFile(path.join(f.destination, "ui-locale.txt"))).rejects.toThrow();
});
it("copies into the profile beside the copied entries", async () => {
  const f = await fixture();
  const destination = path.join(f.profile, "native-040", "legacy-snapshot");
  await mkdir(path.dirname(destination));
  const first = await snapshotLegacyProfile({ ...f, destination });
  expect(await snapshotLegacyProfile({ ...f, destination })).toEqual(first);
  expect((await readdir(destination)).sort()).toEqual(
    [".vnbot-profile-snapshot.json", "files", "native-stack-env", "pg"].sort(),
  );
});
it("resumes an owned incomplete copy without touching the source", async () => {
  const f = await fixture();
  const first = await snapshotLegacyProfile(f);
  const staging = `${f.destination}.copying`;
  await rename(f.destination, staging);
  await writeFile(
    path.join(staging, ".vnbot-profile-snapshot.json"),
    JSON.stringify({ version: 1, phase: "copying", sourceDigest: first.sourceDigest }),
  );
  await writeFile(path.join(staging, "files/chat.txt"), "partial");
  expect(await snapshotLegacyProfile(f)).toEqual(first);
  expect(await readFile(path.join(f.destination, "files/chat.txt"), "utf8")).toBe("preserved file");
  expect(await readFile(path.join(f.profile, "files/chat.txt"), "utf8")).toBe("preserved file");
});
it("refuses a running source and leaves its process marker intact", async () => {
  const f = await fixture();
  const pid = path.join(f.profile, "pg/data/postmaster.pid");
  await writeFile(pid, "123\n");
  await expect(snapshotLegacyProfile(f)).rejects.toThrow("must be stopped");
  expect(await readFile(pid, "utf8")).toBe("123\n");
  await expect(
    readFile(path.join(f.destination, ".vnbot-profile-snapshot.json")),
  ).rejects.toThrow();
});
it("keeps a destination that was not created by the copy operation", async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await writeFile(path.join(f.destination, "keep.txt"), "user work");
  await expect(snapshotLegacyProfile(f)).rejects.toThrow("Unrecognized");
  expect(await readFile(path.join(f.destination, "keep.txt"), "utf8")).toBe("user work");
});
it("detects source changes and does not overwrite an older verified snapshot", async () => {
  const f = await fixture();
  await snapshotLegacyProfile(f);
  await writeFile(path.join(f.profile, "files/chat.txt"), "new source");
  await expect(snapshotLegacyProfile(f)).rejects.toThrow("snapshot changed");
  expect(await readFile(path.join(f.destination, "files/chat.txt"), "utf8")).toBe("preserved file");
});
it("detects changes to the verified copy even when its receipt still matches", async () => {
  const f = await fixture();
  await snapshotLegacyProfile(f);
  await writeFile(path.join(f.destination, "native-stack-env"), "changed");
  await expect(snapshotLegacyProfile(f)).rejects.toThrow("snapshot changed");
  expect(await readFile(path.join(f.destination, "native-stack-env"), "utf8")).toBe("changed");
});
it("rejects links and nested destinations rather than copying another location", async () => {
  const f = await fixture();
  await expect(
    snapshotLegacyProfile({ ...f, destination: path.join(f.profile, "pg", "nested") }),
  ).rejects.toThrow("outside");
  await expect(snapshotLegacyProfile({ ...f, destination: f.profile })).rejects.toThrow("outside");
  await symlink(path.join(f.profile, "files/chat.txt"), path.join(f.profile, "files/linked"));
  await expect(snapshotLegacyProfile(f)).rejects.toThrow("symbolic links");
});
