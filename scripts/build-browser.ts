import tailwind from "bun-plugin-tailwind";
import { watch } from "fs";
import { cp, readdir, rm } from "fs/promises";
import { basename, resolve } from "path";
import {
  browserBuildMode,
  lazyChunkPaths,
  metafileInputs,
  verifyProductionBundle,
} from "./browser-build-mode";

const isWatch = process.argv.includes("--watch");
const mode = browserBuildMode(
  isWatch || process.argv.includes("--development")
);

const REPO_URL = process.env.REPO_URL ?? "https://github.com/jennings/pulldash";
const define = {
  __REPO_URL__: JSON.stringify(REPO_URL),
  ...mode.define,
};

async function build() {
  const workerResult = await buildWorker();
  if (!workerResult.success) {
    console.error("Worker build failed:", workerResult.logs);
    return false;
  }
  const workerUrl = `/lib/${workerResult.outputs[0]!.path.split("/").at(-1)}`;
  const pierreResult = await buildPierreWorker();
  if (!pierreResult.success) {
    console.error("Pierre worker build failed:", pierreResult.logs);
    return false;
  }
  const pierreEntry = pierreResult.outputs.find(
    (o) => o.kind === "entry-point"
  );
  if (!pierreEntry) {
    console.error("Pierre worker build produced no entry point");
    return false;
  }
  const pierreWorkerUrl = `/pierre/${basename(pierreEntry.path)}`;
  // Installed before the main build because its URL is baked into the app; the
  // staged files are only copied in once the worker build has succeeded.
  await installPierreWorker(pierreResult.outputs.map((o) => basename(o.path)));
  // Build main app
  const mainResult = await Bun.build({
    entrypoints: ["./src/browser/index.html"],
    outdir: "./dist/browser",
    plugins: [tailwind],
    target: "browser",
    format: "esm",
    splitting: true,
    metafile: true,
    minify: mode.minify,
    define: {
      ...define,
      __DIFF_WORKER_URL__: JSON.stringify(workerUrl),
      __PIERRE_WORKER_URL__: JSON.stringify(pierreWorkerUrl),
    },
  });

  if (!mainResult.success) {
    console.error("Main build failed:");
    for (const log of mainResult.logs) {
      console.error(log);
    }
    return false;
  }

  if (mode.minify) {
    await verifyProductionBundle(mainResult.outputs);
  }

  // Every build emits a fresh set of hashed chunks (hundreds, because pierre's
  // main-thread fallback imports Shiki grammars dynamically). Drop the ones
  // this build no longer produces, after the new ones exist so a running dev
  // server never sees a gap.
  const fresh = new Set(mainResult.outputs.map((o) => basename(o.path)));
  for (const file of await readdir("./dist/browser")) {
    if (file.startsWith("chunk-") && !fresh.has(file)) {
      await rm(resolve("./dist/browser", file), { force: true });
    }
  }

  // Make paths absolute to root in index.html and inject spa redirect script
  const indexPath = "./dist/browser/index.html";
  const indexHtml = await Bun.file(indexPath).text();
  await Bun.write(
    indexPath,
    indexHtml
      .replaceAll("./", "/")
      .replace("</head>", '<script src="/spa-redirect.js"></script></head>')
  );

  await cp(
    resolve(process.cwd(), "src", "browser", "logo.svg"),
    resolve(process.cwd(), "dist", "browser", "logo.svg")
  );

  await cp(
    resolve(process.cwd(), "src", "browser", "404.html"),
    resolve(process.cwd(), "dist", "browser", "404.html")
  );

  // PWA files
  await cp(
    resolve(process.cwd(), "src", "browser", "manifest.json"),
    resolve(process.cwd(), "dist", "browser", "manifest.json")
  );
  await cp(
    resolve(process.cwd(), "src", "browser", "sw.js"),
    resolve(process.cwd(), "dist", "browser", "sw.js")
  );

  // Give the service worker the real hashed asset names. Without this it had no
  // way to precache anything and offline simply did not work.
  const swPath = resolve(process.cwd(), "dist", "browser", "sw.js");
  // Bun reports output paths absolute, and relative to the outdir at other
  // times, so anchor on the outdir segment rather than slicing a prefix.
  const outMarker = "dist/browser/";
  const sitePath = (path: string) => {
    const p = path.replaceAll("\\", "/");
    const at = p.lastIndexOf(outMarker);
    return at >= 0 ? p.slice(at + outMarker.length) : p.replace(/^\/+/, "");
  };
  const mainInputs = metafileInputs(mainResult.metafile!, "/");
  const pierreInputs = metafileInputs(pierreResult.metafile!, "/pierre/");
  const mainSite = mainResult.outputs.map((o) => {
    const path = `/${sitePath(o.path)}`;
    return { sitePath: path, kind: o.kind, inputs: mainInputs.get(path) ?? [] };
  });
  const pierreSite = pierreResult.outputs.map((o) => {
    const path = `/pierre/${basename(o.path)}`;
    return {
      sitePath: path,
      kind: o.kind,
      inputs: pierreInputs.get(path) ?? [],
    };
  });
  // Shiki grammar and theme chunks (hundreds) are runtime-cached on first use
  // rather than precached. Everything else, including lazily imported app and
  // Shiki engine chunks, is needed offline and is precached.
  const lazyMain = lazyChunkPaths(mainSite);
  const lazyPierre = lazyChunkPaths(pierreSite);
  const lazy = new Set([...lazyMain, ...lazyPierre]);
  const precache = [
    "/",
    "/spa-redirect.js",
    workerUrl,
    ...[...mainSite, ...pierreSite]
      .map((o) => o.sitePath)
      .filter((p) => /\.(js|css|svg|woff2?)$/.test(p) && !lazy.has(p)),
  ];
  const sw = await Bun.file(swPath).text();
  const injected = sw.replace(
    'self.__PULLDASH_PRECACHE__ ?? ["/"]',
    JSON.stringify([...new Set(precache)])
  );
  if (injected === sw) {
    console.error(
      "sw.js: precache placeholder not found — offline support will be empty"
    );
  }
  await Bun.write(swPath, injected);

  await cp(
    resolve(process.cwd(), "src", "browser", "spa-redirect.js"),
    resolve(process.cwd(), "dist", "browser", "spa-redirect.js")
  );
  await cp(
    resolve(process.cwd(), "src", "browser", "icons"),
    resolve(process.cwd(), "dist", "browser", "icons"),
    { recursive: true }
  );

  const allOutputs = [...mainResult.outputs, ...workerResult.outputs];
  console.log(`Bundled ${allOutputs.length} files`);
  for (const output of allOutputs)
    console.log(`  ${output.path} (${(output.size / 1024).toFixed(1)} KiB)`);
  console.log(
    `Main build: ${mainResult.outputs.length} files, ${lazyMain.size} lazy Shiki chunks not precached`
  );
  console.log(
    `Pierre worker: ${pierreResult.outputs.length} files, ${lazyPierre.size} lazy Shiki chunks not precached, entry ${pierreWorkerUrl}`
  );
  console.log(`Service worker precache: ${new Set(precache).size} URLs`);
  return true;
}

function buildWorker() {
  return Bun.build({
    entrypoints: ["./src/browser/lib/diff-worker.ts"],
    outdir: "./dist/browser/lib",
    naming: "[name]-[hash].[ext]",
    target: "browser",
    format: "esm",
    minify: mode.minify,
    define,
    banner: `// Worker shim for libraries that check for document (Prism/refractor)
if (typeof document === 'undefined') {
  globalThis.document = {
    currentScript: null,
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    getElementsByClassName: () => [],
    getElementsByTagName: () => [],
    createElement: () => ({
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: () => {},
      removeChild: () => {},
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      style: {},
      innerHTML: '',
      textContent: '',
    }),
    createTextNode: () => ({ textContent: '' }),
    createDocumentFragment: () => ({ appendChild: () => {}, childNodes: [] }),
    head: { appendChild: () => {}, removeChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
`,
  });
}

const PIERRE_STAGING = "./dist/.pierre-build";
const PIERRE_OUT = "./dist/browser/pierre";

/**
 * Pierre's highlighter worker. Splitting keeps Shiki's ~480 grammar/theme
 * modules as lazily loaded chunks instead of one multi-megabyte worker.
 * Built into a staging directory and copied into place by
 * `installPierreWorker`, so the served `pierre/` directory is never empty.
 */
async function buildPierreWorker() {
  await rm(PIERRE_STAGING, { recursive: true, force: true });
  return Bun.build({
    entrypoints: [
      Bun.fileURLToPath(import.meta.resolve("@pierre/diffs/worker/worker.js")),
    ],
    outdir: PIERRE_STAGING,
    naming: "[name]-[hash].[ext]",
    target: "browser",
    format: "esm",
    splitting: true,
    metafile: true,
    minify: mode.minify,
    define,
  });
}

/**
 * Copies the staged worker over `dist/browser/pierre`, then removes files the
 * new build no longer produces. Files are content-hashed, so overwriting in
 * place never changes what a given URL serves; unlike deleting the directory
 * first, a request arriving mid-build still finds its file.
 */
async function installPierreWorker(files: string[]) {
  await cp(PIERRE_STAGING, PIERRE_OUT, { recursive: true, force: true });
  const fresh = new Set(files);
  for (const file of await readdir(PIERRE_OUT)) {
    if (!fresh.has(file)) {
      await rm(resolve(PIERRE_OUT, file), { recursive: true, force: true });
    }
  }
  await rm(PIERRE_STAGING, { recursive: true, force: true });
}

if (!(await build()) && !isWatch) process.exitCode = 1;

if (isWatch) {
  console.log("\nWatching for changes...");
  const srcDir = resolve(import.meta.dir, "..", "src", "browser");

  let debounce: Timer | null = null;
  watch(srcDir, { recursive: true }, (_event, filename) => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      console.log(`\nFile changed: ${filename}`);
      await build();
    }, 100);
  });
}
