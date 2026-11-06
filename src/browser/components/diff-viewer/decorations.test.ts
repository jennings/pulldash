import { expect, test } from "bun:test";
import type { DiffRow } from "../../lib/file-diff";
import { STATIC_CSS, buildDecorationCss, draftLinesFor } from "./decorations";

const base = {
  rows: [] as DiffRow[],
  rangeLines: new Set<string>(),
  draftLines: new Set<number>(),
  focusedGap: null,
};

test("comment ranges select line numbers per column in split diffs", () => {
  const css = buildDecorationCss({
    ...base,
    style: "split",
    rangeLines: new Set(["12:new", "7:old"]),
  });
  expect(css).toContain('[data-additions] [data-column-number="12"] {');
  expect(css).toContain('[data-deletions] [data-column-number="7"] {');
});

test("unified diffs tell old-side lines apart by their deletion type", () => {
  const css = buildDecorationCss({
    ...base,
    style: "unified",
    rangeLines: new Set(["12:new", "7:old"]),
    draftLines: new Set([3]),
  });
  expect(css).toContain(
    '[data-unified] [data-column-number="12"]:not([data-line-type="change-deletion"]) {'
  );
  expect(css).toContain(
    '[data-unified] [data-column-number="7"][data-line-type="change-deletion"] {'
  );
  // A draft's side is unknown, so both are marked.
  expect(css).toContain(
    '[data-unified] [data-column-number="3"]:not([data-line-type="change-deletion"])::after'
  );
  expect(css).toContain(
    '[data-unified] [data-column-number="3"][data-line-type="change-deletion"]::after'
  );
});

test("old-side lines of unified context rows are drawn under their new number", () => {
  const rows: DiffRow[] = [
    {
      kind: "line",
      type: "context",
      oldLine: 4,
      newLine: 6,
      text: "x",
      hunkIndex: 0,
    },
  ];
  const input = { ...base, rows, rangeLines: new Set(["4:old"]) };
  const unified = buildDecorationCss({ ...input, style: "unified" });
  expect(unified).toContain(
    '[data-unified] [data-column-number="4"][data-line-type="change-deletion"] {'
  );
  expect(unified).toContain(
    '[data-unified] [data-column-number="6"]:not([data-line-type="change-deletion"]) {'
  );
  // A split diff has a column per side, so the old number is right.
  expect(buildDecorationCss({ ...input, style: "split" })).not.toContain('"6"');
});

test("the focused gap is outlined by its expand index; search rules are static", () => {
  const css = buildDecorationCss({ ...base, style: "unified", focusedGap: 2 });
  expect(css).toContain('[data-separator][data-expand-index="2"]');
  expect(buildDecorationCss({ ...base, style: "unified" })).toBe("");
  expect(STATIC_CSS).toContain("::highlight(pd-search)");
});

test("draftLinesFor reads end lines of non-empty drafts for one file only", () => {
  expect(
    draftLinesFor(
      {
        "src/a.ts:12:": "wip",
        "src/a.ts:20:15": "range draft",
        "src/a.ts:30:": "   ",
        "src/b.ts:5:": "other file",
        "weird:name.ts:8:": "colon in path",
      },
      "src/a.ts"
    )
  ).toEqual(new Set([12, 20]));
  expect(draftLinesFor({ "weird:name.ts:8:": "x" }, "weird:name.ts")).toEqual(
    new Set([8])
  );
});
