import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeExternals = ["node-datachannel", "@embedded-postgres/*"];
// Keep identifiers so stack traces stay readable; whitespace and syntax shrink the bundles.
const minify = { minifyWhitespace: true, minifySyntax: true, keepNames: true };
const requireBanner =
  'import { createRequire as __desktopCreateRequire } from "node:module"; const require = __desktopCreateRequire(import.meta.url);';

// Split dynamic imports so main-app's Electron imports stay out of migration mode.
// The utility process still enters through dist/main.js.
await rm(path.join(desktop, "dist"), { recursive: true, force: true });
await build({
  absWorkingDir: desktop,
  entryPoints: ["src/main.ts"],
  outdir: "dist",
  splitting: true,
  // Source-relative runtime paths (preloads and the migration entry) share dist/.
  chunkNames: "[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  banner: { js: requireBanner },
  external: ["electron", "electron-updater", "koffi", "@sentry/electron", ...nativeExternals],
});

if (process.argv.includes("--native") || process.env.DESKTOP_NATIVE === "1") {
  const server = path.join(desktop, "native/server");
  await rm(server, { recursive: true, force: true });
  await mkdir(server, { recursive: true });
  const installed = new Map();
  let versionSlot = 0;
  const entryPackages = new Map();

  // Platform packages (sharp's libvips, koffi's addon) are optional dependencies
  // gated by os/cpu/libc. Install only the one this build targets, so the host
  // platform (process.platform) decides: win32 packages on Windows CI, linux
  // glibc or musl variants on Linux, never every platform at once.
  const hostLibc =
    process.platform === "linux"
      ? process.report?.getReport().header.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : undefined;
  function matchesHost(manifest) {
    const allows = (list, value) =>
      !Array.isArray(list) || list.length === 0 || (value !== undefined && list.includes(value));
    const denies = (list, value) => Array.isArray(list) && list.includes(`!${value}`);
    return (
      allows(
        manifest.os?.filter((x) => !x.startsWith("!")),
        process.platform,
      ) &&
      allows(
        manifest.cpu?.filter((x) => !x.startsWith("!")),
        process.arch,
      ) &&
      !denies(manifest.os, process.platform) &&
      !denies(manifest.cpu, process.arch) &&
      (!manifest.libc || hostLibc === undefined || manifest.libc.includes(hostLibc))
    );
  }

  // Resolve directories through Node's search paths, including pnpm's real package paths.
  // This also works for packages that don't export their package.json or a root entry.
  async function packageRoot(name, from) {
    const require = createRequire(path.join(from, "package.json"));
    for (const modules of require.resolve.paths(`${name}/package.json`) ?? []) {
      const candidate = path.join(modules, name);
      if (existsSync(path.join(candidate, "package.json"))) return realpath(candidate);
    }
    throw new Error(`Missing production dependency: ${name}`);
  }

  async function install(name, from, parent = server) {
    const source = await packageRoot(name, from);
    if (parent === server && entryPackages.has(source)) return entryPackages.get(source);
    // Reuse only the first visible version, matching Node's lookup rules.
    for (let dir = parent; dir.startsWith(server); dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (installed.has(candidate)) {
        if (installed.get(candidate) === source) return candidate;
        break;
      }
      if (dir === server) break;
    }
    const hoisted = path.join(server, "node_modules", name);
    const destination = !installed.has(hoisted)
      ? hoisted
      : parent === server
        ? path.join(server, "runtime-versions", String(++versionSlot), "node_modules", name)
        : path.join(parent, "node_modules", name);
    installed.set(destination, source); // Register before recursion to handle dependency cycles.
    if (parent === server) entryPackages.set(source, destination);
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (file) => !path.relative(source, file).split(path.sep).includes("node_modules"),
    });
    const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    const optional = manifest.optionalDependencies ?? {};
    const dependencies = { ...manifest.dependencies, ...optional };
    for (const dependency of Object.keys(dependencies)) {
      // Type declarations listed as dependencies are never loaded at runtime.
      if (dependency === "pg-native" || dependency.startsWith("@types/")) continue;
      try {
        const dependencyRoot = await packageRoot(dependency, source);
        const dependencyManifest = JSON.parse(
          await readFile(path.join(dependencyRoot, "package.json"), "utf8"),
        );
        if (!matchesHost(dependencyManifest)) continue;
      } catch (error) {
        if (dependency in optional || !(dependency in (manifest.dependencies ?? {}))) continue;
        throw error;
      }
      await install(dependency, source, destination);
    }
    return destination;
  }

  // Migration utilities resolve these relative to server/db and server/adapters.
  // graphile-worker also reads its SQL migrations from its own package directory.
  await install("pg", path.resolve(desktop, "../../packages/db"));
  await install("graphile-worker", path.resolve(desktop, "../../packages/adapters"));
  // Sharp selects a platform .node addon and libvips shared library through
  // createRequire(import.meta.url); Koffi selects its FFI .node addon the same way.
  // Preserve their package layouts and installed optional binary dependencies.
  for (const name of ["sharp", "koffi"]) {
    await install(name, path.resolve(desktop, "../../packages/adapters"));
  }
  // pg-native is optional: pg catches its absence and uses the JavaScript driver.
  const externals = ["pg", "graphile-worker", "pg-native", "sharp", "koffi"];

  const jsdom = await packageRoot("jsdom", path.resolve(desktop, "../../packages/adapters"));
  const sentry = await packageRoot("@sentry/node", path.resolve(desktop, "../../packages/logging"));
  const sentryInjection = await packageRoot("@sentry/server-runtime-injection", sentry);
  const runtimeAssets = {
    name: "native-runtime-assets",
    setup(builder) {
      // Inline jsdom's stylesheet rather than copying its entire dependency tree.
      builder.onLoad({ filter: /jsdom[/\\]lib[/\\].*[/\\]computed-style\.js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const contents = source.replace(
          /fs\.readFileSync\(\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{ encoding: "utf-8" \}\s*\)/,
          'require("../../../browser/default-stylesheet.css")',
        );
        if (contents === source) throw new Error("jsdom stylesheet lookup changed");
        return { contents, loader: "js" };
      });
      // Keep synchronous XHR working with one separately bundled worker asset.
      builder.onLoad({ filter: /jsdom[/\\].*[/\\]XMLHttpRequest-impl\.js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const contents = source.replace(
          'require.resolve("./xhr-sync-worker.js")',
          'require("node:url").fileURLToPath(new URL("./xhr-sync-worker.mjs", import.meta.url))',
        );
        if (contents === source) throw new Error("jsdom worker lookup changed");
        return { contents, loader: "js" };
      });
      // Pi's variable-specifier imports hide these lazy modules from esbuild.
      // Make the existing literal targets visible without externalizing the SDK.
      builder.onLoad(
        {
          filter:
            /pi-ai[/\\]dist[/\\](api[/\\]bedrock-converse-stream\.lazy|auth[/\\]oauth[/\\]load)\.js$/,
        },
        async (args) => ({
          contents: (await readFile(args.path, "utf8")).replace(
            /(?:importNodeOnlyApi|importOAuthModule)\("(\.\/[^"\n]+)\.ts"\)/g,
            'import("$1.js")',
          ),
          loader: "js",
        }),
      );
      // Lark reads only its version from package.json. Inline that metadata.
      builder.onLoad(
        { filter: /@larksuiteoapi[/\\]node-sdk[/\\]lib[/\\]index\.js$/ },
        async (args) => {
          const manifest = JSON.parse(
            await readFile(path.resolve(path.dirname(args.path), "../package.json"), "utf8"),
          );
          const source = await readFile(args.path, "utf8");
          const contents = source.replace(
            "let cachedVersion;",
            `let cachedVersion = ${JSON.stringify(manifest.version)};`,
          );
          if (contents === source) throw new Error("Lark version lookup changed");
          return { contents, loader: "js" };
        },
      );
    },
  };

  // The diagram route serves this browser asset using createRequire(). Copy only
  // the asset and manifest, never Mermaid's build-time dependency tree.
  const mermaid = await packageRoot("mermaid", path.resolve(desktop, "../api"));
  await mkdir(path.join(server, "node_modules/mermaid/dist"), { recursive: true });
  for (const file of ["package.json", "dist/mermaid.min.js"]) {
    await cp(path.join(mermaid, file), path.join(server, "node_modules/mermaid", file));
  }
  for (const [name, entry] of [
    ["api", "../api/src/index.ts"],
    ["worker", "../worker/src/index.ts"],
    ["db", "../../packages/db/src/database-access.ts"],
  ]) {
    const outfile = path.join(
      server,
      name,
      "dist",
      name === "db" ? "database-access.js" : "index.js",
    );
    await build({
      absWorkingDir: desktop,
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      conditions: ["node"],
      sourcemap: false,
      ...minify,
      logLevel: "warning",
      banner: { js: requireBanner },
      external: externals,
      loader: { ".css": "text" },
      plugins: [runtimeAssets],
    });
  }
  // Sentry's optional Node loader registers hook.js relative to the bundle.
  // Ship that hook as a bundle too, rather than its full instrumentation tree.
  for (const name of ["api", "worker"]) {
    for (const [entry, output] of [
      [path.join(jsdom, "lib/jsdom/living/xhr/xhr-sync-worker.js"), "xhr-sync-worker.mjs"],
      [path.join(sentryInjection, "build/esm/hook.js"), "hook.js"],
    ]) {
      await build({
        entryPoints: [entry],
        outfile: path.join(server, name, "dist", output),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        ...minify,
        banner: { js: requireBanner },
        external: externals,
        loader: { ".css": "text" },
        plugins: [runtimeAssets],
      });
    }
  }
  for (const name of ["api", "worker", "db", "adapters"]) {
    await mkdir(path.join(server, name), { recursive: true });
    await writeFile(
      path.join(server, name, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
  }
  // client-build.ts resolves ../../web/dist/build-id from the bundled API entry.
  const buildId = path.resolve(desktop, "../web/dist/build-id");
  if (existsSync(buildId)) {
    await mkdir(path.join(server, "web/dist"), { recursive: true });
    await cp(buildId, path.join(server, "web/dist/build-id"));
  }
  async function measure(directory) {
    let bytes = 0;
    let files = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const child = await measure(file);
        bytes += child.bytes;
        files += child.files;
      } else {
        bytes += (await stat(file)).size;
        files++;
      }
    }
    return { bytes, files };
  }
  const { bytes, files } = await measure(server);
  console.log(
    `Native server: ${(bytes / 1_000_000).toFixed(2)} MB (${bytes} bytes), ${files} files.`,
  );
  if (bytes >= 250_000_000 || files >= 15_000) {
    throw new Error("Native server must stay below 250 MB and 15,000 files.");
  }
}
