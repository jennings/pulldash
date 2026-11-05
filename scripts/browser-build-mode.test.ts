import { expect, test } from "bun:test";
import {
  browserBuildMode,
  lazyChunkPaths,
  metafileInputs,
  verifyProductionBundle,
} from "./browser-build-mode";

test("release React artifacts use production code while development keeps diagnostics", async () => {
  for (const development of [false, true]) {
    const result = await Bun.build({
      entrypoints: [Bun.resolveSync("react-dom/client", import.meta.dir)],
      target: "browser",
      ...browserBuildMode(development),
    });
    expect(result.success).toBe(true);
    if (development) {
      await expect(verifyProductionBundle(result.outputs)).rejects.toThrow(
        "development code"
      );
    } else {
      await verifyProductionBundle(result.outputs);
    }
  }
});

test("release verification rejects artifacts without production React", async () => {
  await expect(
    verifyProductionBundle([{ path: "empty.js", text: async () => "" }])
  ).rejects.toThrow("missing the production React runtime");
});

test("lazy chunk detection drops only Shiki grammar/theme chunks, not app-level import() targets", () => {
  const chunk = (sitePath: string, inputs: string[]) => ({
    sitePath,
    kind: "chunk",
    inputs,
  });
  const lazy = lazyChunkPaths([
    { sitePath: "/index.js", kind: "entry-point", inputs: ["src/index.tsx"] },
    // Reached through import() (e.g. React.lazy) but app code: precached.
    chunk("/chunk-app.js", [
      "src/browser/components/pr-review.tsx",
      "node_modules/react/index.js",
    ]),
    // Shiki engine is import()ed too, yet the worker needs it for every diff.
    chunk("/chunk-engine.js", [
      "node_modules/@shikijs/engine-javascript/x.mjs",
    ]),
    // A grammar bundled with another language's input is not purely a grammar.
    chunk("/chunk-mixed.js", [
      "node_modules/@shikijs/langs/dist/css.mjs",
      "node_modules/@shikijs/core/index.mjs",
    ]),
    // No inputs: cannot be proven a grammar, so it stays precached.
    chunk("/chunk-empty.js", []),
    chunk("/pierre/chunk-lang.js", [
      "node_modules/@shikijs/langs/dist/verilog.mjs",
    ]),
    chunk("/chunk-theme.js", [
      "node_modules/@shikijs/themes/dist/github-dark.mjs",
      "node_modules/@shikijs/themes/dist/github-light.mjs",
    ]),
    chunk("/chunk-win.js", ["node_modules\\@shikijs\\langs\\dist\\go.mjs"]),
    // A grammar-only chunk is never lazy if it is an entry point.
    {
      sitePath: "/pierre/worker.js",
      kind: "entry-point",
      inputs: ["node_modules/@shikijs/langs/dist/a.mjs"],
    },
  ]);
  expect([...lazy].sort()).toEqual([
    "/chunk-theme.js",
    "/chunk-win.js",
    "/pierre/chunk-lang.js",
  ]);
});

test("metafile inputs are keyed by site path", () => {
  const inputs = metafileInputs(
    {
      outputs: {
        "./chunk-a.js": { inputs: { "node_modules/@shikijs/langs/a.mjs": {} } },
        "./index.html": { inputs: {} },
      },
    },
    "/pierre/"
  );
  expect(inputs.get("/pierre/chunk-a.js")).toEqual([
    "node_modules/@shikijs/langs/a.mjs",
  ]);
  expect(inputs.get("/pierre/index.html")).toEqual([]);
});
