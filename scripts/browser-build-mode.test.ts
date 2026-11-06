import { expect, test } from "bun:test";
import {
  browserBuildMode,
  lazyChunkPaths,
  metafileInputs,
  repointEntryScript,
  verifyEntryScript,
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

test("lazy chunk detection drops only Shiki and spare Highlights theme chunks, not app-level import() targets", () => {
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
    // The Highlights engine and its theme lookup are needed for every diff.
    chunk("/chunk-highlights.js", [
      "node_modules/@pierre/highlights/dist/tokens.js",
      "node_modules/@pierre/highlights/dist/theme.js",
    ]),
    // The theme resolver (`@pierre/theming`, not `@pierre/theme`) is needed too.
    chunk("/chunk-theming.js", ["node_modules/@pierre/theming/dist/index.js"]),
    chunk("/chunk-theme-loader.js", [
      "node_modules/@pierre/highlights/dist/themes/loader.js",
    ]),
    // The two themes the app renders with are precached...
    chunk("/chunk-pierre-light.js", [
      "node_modules/@pierre/highlights/dist/themes/pierre-light.js",
    ]),
    chunk("/chunk-pierre-dark.js", [
      "node_modules/@pierre/highlights/dist/themes/pierre-dark.js",
    ]),
    // ...every other Highlights theme (including pierre-light variants) is not.
    chunk("/chunk-hl-dracula.js", [
      "node_modules/@pierre/highlights/dist/themes/dracula.js",
    ]),
    chunk("/chunk-hl-pierre-soft.js", [
      "node_modules/@pierre/highlights/dist/themes/pierre-light-soft.js",
    ]),
    // Shiki's engine only runs in the fallback, so it is lazy like its grammars.
    chunk("/chunk-engine.js", [
      "node_modules/@shikijs/engine-javascript/x.mjs",
      "node_modules/oniguruma-parser/index.js",
      "node_modules/oniguruma-to-es/dist/esm/index.js",
      "node_modules/regex/index.js",
    ]),
    chunk("/chunk-pierre-textmate.js", ["node_modules/@pierre/theme/x.js"]),
    // A grammar bundled with app code is not purely lazy.
    chunk("/chunk-mixed.js", [
      "node_modules/@shikijs/langs/dist/css.mjs",
      "src/browser/lib/pierre.tsx",
    ]),
    // No inputs: cannot be proven lazy, so it stays precached.
    chunk("/chunk-empty.js", []),
    chunk("/chunk-lang.js", ["node_modules/@shikijs/langs/dist/verilog.mjs"]),
    chunk("/chunk-theme.js", [
      "node_modules/@shikijs/themes/dist/github-dark.mjs",
      "node_modules/@shikijs/themes/dist/github-light.mjs",
    ]),
    chunk("/chunk-win.js", ["node_modules\\@shikijs\\langs\\dist\\go.mjs"]),
    // A grammar-only chunk is never lazy if it is an entry point.
    {
      sitePath: "/entry.js",
      kind: "entry-point",
      inputs: ["node_modules/@shikijs/langs/dist/a.mjs"],
    },
  ]);
  expect([...lazy].sort()).toEqual([
    "/chunk-engine.js",
    "/chunk-hl-dracula.js",
    "/chunk-hl-pierre-soft.js",
    "/chunk-lang.js",
    "/chunk-pierre-textmate.js",
    "/chunk-theme.js",
    "/chunk-win.js",
  ]);
});

test("metafile inputs are keyed by site path", () => {
  const inputs = metafileInputs({
    outputs: {
      "./chunk-a.js": { inputs: { "node_modules/@shikijs/langs/a.mjs": {} } },
      "./index.html": { inputs: {} },
    },
  });
  expect(inputs.get("/chunk-a.js")).toEqual([
    "node_modules/@shikijs/langs/a.mjs",
  ]);
  expect(inputs.get("/index.html")).toEqual([]);
});

test("a split chunk wrongly linked from index.html is repointed to the entry-point output, and verification rejects the original", () => {
  const html = (src: string) =>
    `<head><link rel="stylesheet" href="./app.css"><script type="module" crossorigin src="${src}"></script></head>`;
  const outputs = [
    { path: "/out/chunk-shared.js", kind: "chunk" },
    { path: "/out/chunk-entry.js", kind: "entry-point" },
    { path: "/out/index.html", kind: "entry-point" },
  ];

  const bad = html("./chunk-shared.js");
  expect(() => verifyEntryScript(bad, outputs)).toThrow(
    "loads chunk-shared.js but the entry point is chunk-entry.js"
  );
  const fixed = repointEntryScript(bad, outputs);
  expect(fixed).toEqual({
    html: html("./chunk-entry.js"),
    from: "chunk-shared.js",
    to: "chunk-entry.js",
  });
  verifyEntryScript(fixed.html, outputs);

  // Already correct: untouched.
  const good = html("./chunk-entry.js");
  expect(repointEntryScript(good, outputs).html).toBe(good);
});

test("entry script checks reject HTML without a module script and bundles without exactly one JS entry", () => {
  const outputs = [{ path: "chunk-entry.js", kind: "entry-point" }];
  expect(() => verifyEntryScript("<head></head>", outputs)).toThrow(
    "no module script"
  );
  expect(() =>
    verifyEntryScript('<script type="module" src="./a.js"></script>', [
      { path: "index.html", kind: "entry-point" },
    ])
  ).toThrow("exactly one JavaScript entry-point");
});
