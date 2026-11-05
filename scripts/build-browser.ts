import tailwind from "bun-plugin-tailwind";
import { watch } from "fs";
import { cp, readdir, rm } from "fs/promises";
import { basename, resolve } from "path";
import {
  browserBuildMode,
  lazyChunkPaths,
  metafileInputs,
  repointEntryScript,
  verifyEntryScript,
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
  // Hashed names change on every build; drop previous workers once the new one exists.
  const freshWorkers = new Set(
    workerResult.outputs.map((o) => basename(o.path))
  );
  for (const file of await readdir("./dist/browser/lib")) {
    if (!freshWorkers.has(file)) {
      await rm(resolve("./dist/browser/lib", file), { force: true });
    }
  }
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

  // Every build emits a fresh set of hashed chunks (hundreds, because pierre
  // imports Highlights themes and Shiki grammars dynamically). Drop the ones
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
  const builtHtml = await Bun.file(indexPath).text();
  const {
    html: indexHtml,
    from,
    to,
  } = repointEntryScript(builtHtml, mainResult.outputs);
  if (from !== to) {
    console.warn(
      `index.html loaded ${from} instead of the entry point; using ${to}`
    );
  }
  verifyEntryScript(indexHtml, mainResult.outputs);
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
  const mainInputs = metafileInputs(mainResult.metafile!);
  const mainSite = mainResult.outputs.map((o) => {
    const path = `/${sitePath(o.path)}`;
    return { sitePath: path, kind: o.kind, inputs: mainInputs.get(path) ?? [] };
  });
  // Shiki and Highlights grammar/theme chunks (hundreds) are runtime-cached on
  // first use rather than precached. Everything else, including lazily imported
  // app chunks and the highlighter engines, is needed offline and is precached.
  const lazyMain = lazyChunkPaths(mainSite);
  const precache = [
    "/",
    "/spa-redirect.js",
    workerUrl,
    ...mainSite
      .map((o) => o.sitePath)
      .filter((p) => /\.(js|css|svg|woff2?)$/.test(p) && !lazyMain.has(p)),
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
    `Main build: ${mainResult.outputs.length} files, ${lazyMain.size} lazy Shiki/Highlights chunks not precached`
  );
  console.log(`Service worker precache: ${new Set(precache).size} URLs`);
  return true;
}

/** Interdiff worker: the only computation left that is too heavy for the main thread. */
function buildWorker() {
  return Bun.build({
    entrypoints: ["./src/browser/lib/diff-worker.ts"],
    outdir: "./dist/browser/lib",
    naming: "[name]-[hash].[ext]",
    target: "browser",
    format: "esm",
    minify: mode.minify,
    define,
  });
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
