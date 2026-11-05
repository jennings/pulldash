export function browserBuildMode(development: boolean) {
  return {
    minify: !development,
    define: {
      __DEV__: JSON.stringify(development),
      "process.env.NODE_ENV": JSON.stringify(
        development ? "development" : "production"
      ),
    },
  };
}

export async function verifyProductionBundle(
  outputs: Array<{ path: string; text: () => Promise<string> }>
) {
  const sources = await Promise.all(
    outputs
      .filter((output) => output.path.endsWith(".js"))
      .map((output) => output.text())
  );
  if (
    sources.some((source) =>
      /react(?:-dom)?(?:-client)?\.development\.js|Download the React DevTools|process\.env\.NODE_ENV/.test(
        source
      )
    )
  ) {
    throw new Error(
      "Release bundle contains development code or unresolved NODE_ENV"
    );
  }
  if (!sources.some((source) => source.includes("Minified React error #"))) {
    throw new Error("Release bundle is missing the production React runtime");
  }
}

const MODULE_SCRIPT = /(<script\b[^>]*\btype="module"[^>]*\bsrc=")([^"]*)(")/;

const fileName = (path: string) => path.split(/[\\/]/).at(-1)!;

/** File name of the bundle's one JavaScript entry-point output (not its split chunks). */
function entryScriptName(outputs: Array<{ path: string; kind: string }>) {
  const entries = outputs.filter(
    (o) => o.kind === "entry-point" && o.path.endsWith(".js")
  );
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one JavaScript entry-point output, found ${entries.length}`
    );
  }
  return fileName(entries[0]!.path);
}

/**
 * The module script an HTML entry loads, as a file name; null if it has none.
 */
function htmlEntryScript(html: string): string | null {
  const src = MODULE_SCRIPT.exec(html)?.[2];
  return src ? fileName(src) : null;
}

/**
 * Bun 1.3.14 can point an HTML entry's `<script type="module">` at an
 * unrelated split chunk (the first one in `outputs`, e.g. a shared 82-byte
 * module) instead of the entry chunk it built, which leaves the app unable to
 * boot. Which chunk comes first depends on the import graph, so no source
 * change reliably avoids it. Points the script at the real entry output;
 * returns the html untouched when it already does.
 */
export function repointEntryScript(
  html: string,
  outputs: Array<{ path: string; kind: string }>
): { html: string; from: string | null; to: string } {
  const to = entryScriptName(outputs);
  const from = htmlEntryScript(html);
  if (from === null || from === to) return { html, from, to };
  return {
    html: html.replace(
      MODULE_SCRIPT,
      (_match, open: string, src: string, close: string) =>
        open + src.slice(0, src.length - from.length) + to + close
    ),
    from,
    to,
  };
}

/** Fails the build when the HTML entry's module script is not the entry-point output. */
export function verifyEntryScript(
  html: string,
  outputs: Array<{ path: string; kind: string }>
) {
  const expected = entryScriptName(outputs);
  const actual = htmlEntryScript(html);
  if (actual !== expected) {
    throw new Error(
      `index.html loads ${actual ?? "no module script"} but the entry point is ${expected}`
    );
  }
}

/**
 * Inputs only the diff highlighter's fallback and its theme catalog use:
 * Shiki (grammars, themes, engines and their helpers), Pierre's TextMate
 * themes, and every Highlights theme except the two the app renders with.
 * The `highlights` backend that runs everywhere WebAssembly SIMD does needs
 * none of this except `pierre-light`/`pierre-dark` and the theme loader.
 */
const LAZY_INPUT =
  /node_modules\/(?:@shikijs\/[^/]+\/|shiki\/|@pierre\/theme\/|oniguruma-parser\/|oniguruma-to-es\/|regex\/|regex-utilities\/|regex-recursion\/|@pierre\/highlights\/dist\/themes\/(?!(?:loader|pierre-light|pierre-dark)\.js$))/;

/**
 * Site paths of chunks that belong in the on-demand cache rather than the
 * offline precache: those made up solely of `LAZY_INPUT` modules (~400 chunks,
 * each loaded only when that grammar/theme/engine is needed).
 *
 * Laziness is decided by where a chunk's code came from, not by how it is
 * reached. A chunk that is merely `import()`ed by the app (the PR review view,
 * the Highlights engine) is still needed offline and is precached. A chunk
 * with no recorded inputs (a pure re-export or helper chunk) is precached too:
 * it cannot be shown to be lazy, and precaching a stray tiny file is safe
 * while missing a needed one breaks offline.
 *
 * `inputs` are the source paths from the build's metafile for that output.
 */
export function lazyChunkPaths(
  outputs: Array<{ sitePath: string; kind: string; inputs: string[] }>
): Set<string> {
  return new Set(
    outputs
      .filter(
        (o) =>
          o.kind === "chunk" &&
          o.sitePath.endsWith(".js") &&
          o.inputs.length > 0 &&
          o.inputs.every((input) =>
            LAZY_INPUT.test(input.replaceAll("\\", "/"))
          )
      )
      .map((o) => o.sitePath)
  );
}

/**
 * Inputs per output from a `Bun.build({ metafile: true })` result, keyed by the
 * output's site path. Metafile output keys are relative to the build's outdir
 * (e.g. "./chunk-abc.js"), which is served from "/".
 */
export function metafileInputs(metafile: {
  outputs: Record<string, { inputs: Record<string, unknown> }>;
}): Map<string, string[]> {
  return new Map(
    Object.entries(metafile.outputs).map(([key, value]) => [
      "/" + key.replace(/^\.\//, ""),
      Object.keys(value.inputs),
    ])
  );
}
