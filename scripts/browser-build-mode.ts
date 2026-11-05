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

const LAZY_INPUT = /node_modules\/@shikijs\/(?:langs|themes)\//;

/**
 * Site paths of chunks that belong in the on-demand cache rather than the
 * offline precache: those made up solely of Shiki grammars and themes (~480 of
 * them, each loaded only when a file in that language/theme is highlighted).
 *
 * Laziness is decided by where a chunk's code came from, not by how it is
 * reached. A chunk that is merely `import()`ed by the app (the PR review view,
 * Shiki's engine) is still needed offline and is precached. A chunk with no
 * recorded inputs (a pure re-export or helper chunk) is precached too: it
 * cannot be shown to be a grammar or theme, and precaching a stray tiny file
 * is safe while missing a needed one breaks offline.
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
 * (e.g. "./chunk-abc.js"); `sitePrefix` is where that outdir is served from
 * ("/" for dist/browser, "/pierre/" for dist/browser/pierre).
 */
export function metafileInputs(
  metafile: { outputs: Record<string, { inputs: Record<string, unknown> }> },
  sitePrefix: string
): Map<string, string[]> {
  return new Map(
    Object.entries(metafile.outputs).map(([key, value]) => [
      sitePrefix + key.replace(/^\.\//, ""),
      Object.keys(value.inputs),
    ])
  );
}
