import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureWindowsLinks } from "./windows-links.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bundle(links: unknown) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "vnbot-links-")));
  roots.push(root);
  await mkdir(path.join(root, "node_modules/.pnpm/b@1/node_modules/b"), { recursive: true });
  await writeFile(path.join(root, "node_modules/.pnpm/b@1/node_modules/b/index.js"), "b");
  await writeFile(path.join(root, "windows-links.json"), JSON.stringify(links));
  return root;
}

const link = {
  link: "node_modules/.pnpm/a@1/node_modules/b",
  target: "node_modules/.pnpm/b@1/node_modules/b",
};

it("recreates listed package links once and leaves a bundle without a list alone", async () => {
  const root = await bundle([link]);
  expect(await ensureWindowsLinks(root, "dir")).toBe(1);
  expect(await readFile(path.join(root, link.link, "index.js"), "utf8")).toBe("b");
  expect(await ensureWindowsLinks(root, "dir")).toBe(0);
  await rm(path.join(root, "windows-links.json"));
  expect(await ensureWindowsLinks(root, "dir")).toBe(0);
});

it("replaces a link left pointing at an earlier install location", async () => {
  const root = await bundle([link]);
  const elsewhere = await realpath(await mkdtemp(path.join(tmpdir(), "vnbot-old-")));
  roots.push(elsewhere);
  await mkdir(path.dirname(path.join(root, link.link)), { recursive: true });
  await symlink(elsewhere, path.join(root, link.link), "dir");
  expect(await ensureWindowsLinks(root, "dir")).toBe(1);
  expect(await readFile(path.join(root, link.link, "index.js"), "utf8")).toBe("b");
});

it.each([
  [{ link: "../outside", target: link.target }],
  [{ link: link.link, target: "../../etc" }],
  [{ link: "", target: link.target }],
])("refuses a link or target outside the bundle: %j", async (entry) => {
  const root = await bundle([entry]);
  await expect(ensureWindowsLinks(root, "dir")).rejects.toThrow("Invalid native bundle links.");
});
