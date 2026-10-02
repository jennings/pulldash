import tailwind from "bun-plugin-tailwind";
import { watch } from "fs";
import { cp } from "fs/promises";
import { resolve } from "path";

const isWatch = process.argv.includes("--watch");

const REPO_URL = process.env.REPO_URL ?? "https://github.com/jennings/pulldash";
const define = {
  __REPO_URL__: JSON.stringify(REPO_URL),
  __DEV__: JSON.stringify(isWatch),
};

async function build() {
  // Build main app
  const mainResult = await Bun.build({
    entrypoints: ["./src/browser/index.html"],
    outdir: "./dist/browser",
    plugins: [tailwind],
    target: "browser",
    format: "esm",
    define,
  });

  if (!mainResult.success) {
    console.error("Main build failed:");
    for (const log of mainResult.logs) {
      console.error(log);
    }
    return false;
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
  const precache = [
    "/",
    "/spa-redirect.js",
    // Built below, and not content-hashed, so it is named here.
    "/lib/diff-worker.js",
    ...mainResult.outputs
      .map((o) => `/${sitePath(o.path)}`)
      .filter((p) => /\.(js|css|svg|woff2?)$/.test(p)),
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

  // Build worker separately with document shim for Prism/refractor
  const workerResult = await Bun.build({
    entrypoints: ["./src/browser/lib/diff-worker.ts"],
    outdir: "./dist/browser/lib",
    target: "browser",
    format: "esm",
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

  if (!workerResult.success) {
    console.error("Worker build failed:");
    for (const log of workerResult.logs) {
      console.error(log);
    }
    return false;
  }

  const allOutputs = [...mainResult.outputs, ...workerResult.outputs];

  console.log(`Bundled ${allOutputs.length} files`);
  for (const output of allOutputs) {
    console.log(`  ${output.path}`);
  }
  return true;
}

await build();

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
