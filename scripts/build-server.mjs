#!/usr/bin/env node
// Bundle a server entrypoint into plain JavaScript so production boots skip compiling
// TypeScript. Usage: build-server.mjs src/index.ts [src/cli/other.ts ...] -> dist/*.js
//
// Workspace packages ship TypeScript source, so they are bundled in. Everything from
// node_modules stays external, but a bare specifier only resolves from the package that
// declares it (pnpm keeps dependencies strict), not from dist/. Each one is therefore
// rewritten to the relative path of the file it resolves to from its importer.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { promptSourceVersion } from "../packages/core/src/node/prompt-source-version.ts";

const builtins = new Set(builtinModules);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * With VNBOT_INLINE_DEPS=1, the desktop build also bundles dependencies, so the app installs a few
 * hundred files instead of every package. These stay external: they find their own files on disk
 * (native addons, platform binaries, worker scripts, proto files) or generate code at install.
 */
export const NATIVE_EXTERNALS = [
  "koffi",
  "prisma",
  "@prisma/",
  ".prisma",
  // The database adapter above checks for its own `pg` pool, so there must be one copy.
  "pg",
  "sharp",
  "@img/",
  "jsdom",
  "esbuild",
  "@esbuild/",
  "@grpc/grpc-js",
];

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const EXTERNAL_MARK = "vnbot-external:";

/** Whether `specifier` stays a separate package when dependencies are bundled. */
export function staysExternal(specifier) {
  const name = packageName(specifier);
  return NATIVE_EXTERNALS.some((entry) =>
    entry.endsWith("/") ? name.startsWith(entry) : name === entry,
  );
}

/** esbuild options for bundling `entry` into `outfile`, shared with the lazy-vendor check. */
export function serverBuildOptions(entry, outfile, { inline = false } = {}) {
  return {
    entryPoints: [entry],
    outfile,
    ...serverBundleOptions(path.dirname(outfile), inline),
  };
}

/**
 * Shared bundle options. `outDir` is where the output files land, so an external import can be
 * rewritten to the path of the file it resolves to.
 */
function serverBundleOptions(outDir, inline) {
  return {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: true,
    define: {
      __RAKAZO_PROMPT_SOURCE_VERSION__: JSON.stringify(
        promptSourceVersion(fileURLToPath(new URL("../", import.meta.url))),
      ),
    },
    // No "module" condition: resolve externals the way Node will.
    conditions: ["node"],
    logLevel: "warning",
    plugins: [
      {
        name: "external-node-modules",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData?.inner) return undefined;
            if (args.path.startsWith("node:") || builtins.has(args.path)) {
              return { path: args.path, external: true };
            }
            if (args.path.startsWith("@rakazo/")) return undefined;
            if (inline && !staysExternal(args.path)) return undefined;
            const resolved = await builder.resolve(args.path, {
              kind: args.kind,
              resolveDir: args.resolveDir,
              importer: args.importer,
              pluginData: { inner: true },
            });
            if (resolved.errors.length > 0) return { errors: resolved.errors };
            // Output files sit at several depths, so their paths are written once each is known.
            if (inline) return { path: `${EXTERNAL_MARK}${resolved.path}`, external: true };
            let relative = path.relative(outDir, resolved.path);
            if (!relative.startsWith(".")) relative = `./${relative}`;
            return { path: relative.split(path.sep).join("/"), external: true };
          });
        },
      },
    ],
  };
}

function inlineScriptAssetsPlugin() {
  const scriptAssetsSuffix = path.join("apps", "api", "src", "script-assets.ts");
  return {
    name: "inline-script-assets",
    setup(builder) {
      builder.onResolve({ filter: /^@rakazo\/page-kit\/runtime-build$/ }, () => ({
        path: "page-runtime-loader",
        namespace: "vnbot-inline-script",
      }));
      builder.onResolve({ filter: /^\.\/mermaid-asset(?:\.js|\.ts)?$/ }, (args) => {
        if (!path.normalize(args.importer).endsWith(scriptAssetsSuffix)) return undefined;
        return {
          path: "mermaid-loader",
          namespace: "vnbot-inline-script",
        };
      });
      builder.onResolve({ filter: /^vnbot-inline-script-data:/ }, (args) => ({
        path: args.path.slice("vnbot-inline-script-data:".length),
        namespace: "vnbot-inline-script-data",
      }));
      builder.onLoad({ filter: /.*/, namespace: "vnbot-inline-script" }, (args) => {
        if (args.path === "page-runtime-loader") {
          return {
            loader: "js",
            contents:
              'export async function buildPageRuntime() { const mod = await import("vnbot-inline-script-data:page-runtime"); return Buffer.from(mod.default, "base64").toString("utf8"); }\n',
          };
        }
        if (args.path === "mermaid-loader") {
          return {
            loader: "js",
            contents:
              'export async function loadMermaidAsset() { const mod = await import("vnbot-inline-script-data:mermaid"); return { version: mod.version, body: new Uint8Array(Buffer.from(mod.base64, "base64")) }; }\n',
          };
        }
        return undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "vnbot-inline-script-data" }, async (args) => {
        if (args.path === "page-runtime") {
          const pageKitRequire = createRequire(
            path.join(repoRoot, "packages", "page-kit", "package.json"),
          );
          const built = await build({
            entryPoints: [pageKitRequire.resolve("@rakazo/page-kit/runtime")],
            bundle: true,
            write: false,
            format: "iife",
            platform: "browser",
            target: ["es2020", "safari15"],
            minify: true,
            jsx: "automatic",
            legalComments: "eof",
            define: { "process.env.NODE_ENV": '"production"' },
            logLevel: "silent",
          });
          const [output] = built.outputFiles;
          if (!output) throw new Error("The page runtime build produced no output.");
          const base64 = Buffer.from(output.text, "utf8").toString("base64");
          return {
            loader: "js",
            contents: `export default ${JSON.stringify(base64)};\n`,
          };
        }
        if (args.path === "mermaid") {
          const apiRequire = createRequire(path.join(repoRoot, "apps", "api", "package.json"));
          const { version } = apiRequire("mermaid/package.json");
          const bytes = await readFile(apiRequire.resolve("mermaid/dist/mermaid.min.js"));
          const base64 = Buffer.from(bytes).toString("base64");
          return {
            loader: "js",
            contents: `export const version = ${JSON.stringify(version)};\nexport const base64 = ${JSON.stringify(base64)};\n`,
          };
        }
        return undefined;
      });
    },
  };
}

/**
 * One build for every entry, sharing chunks. Bundled CommonJS calls `require`, which ES modules
 * lack, so each output file gets one made for it.
 */
export function inlineServerBuildOptions(entries, outDir) {
  const options = serverBundleOptions(outDir, true);
  return {
    ...options,
    plugins: [inlineScriptAssetsPlugin(), ...options.plugins],
    absWorkingDir: process.cwd(),
    entryPoints: entries,
    outdir: outDir,
    outbase: "src",
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    banner: {
      js: `import { createRequire as __vnbotRequire } from "node:module"; const require = __vnbotRequire(import.meta.url);`,
    },
  };
}

/** Builds `entries` into `outDir` with dependencies bundled, external ones linked by path. */
export async function buildInlineServer(entries, outDir) {
  const result = await build({ ...inlineServerBuildOptions(entries, outDir), write: false });
  const marked = new RegExp(`(["'])${EXTERNAL_MARK}([^"']+)\\1`, "g");
  await rm(outDir, { recursive: true, force: true });
  for (const file of result.outputFiles) {
    let text = file.text;
    if (file.path.endsWith(".js")) {
      text = text.replace(marked, (_match, quote, target) => {
        let relative = path.relative(path.dirname(file.path), target);
        if (!relative.startsWith(".")) relative = `./${relative}`;
        return `${quote}${relative.split(path.sep).join("/")}${quote}`;
      });
      if (text.includes(EXTERNAL_MARK)) throw new Error(`Unlinked external in ${file.path}`);
    }
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, text);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.VNBOT_INLINE_DEPS === "1") {
    await buildInlineServer(process.argv.slice(2), path.resolve("dist"));
    process.exit(0);
  }
  for (const entry of process.argv.slice(2)) {
    const outfile = path.resolve("dist", path.relative("src", entry).replace(/\.ts$/, ".js"));
    await build(serverBuildOptions(entry, outfile));
  }
}
