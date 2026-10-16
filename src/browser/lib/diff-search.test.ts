import { test, expect } from "bun:test";
import {
  mapRangeToSegments,
  mergeSearchMatches,
  searchPatches,
  searchRows,
  walkPatchLines,
} from "./diff-search";

const PATCH = `@@ -1,3 +1,4 @@
 context
-removed line
+added line
`;

test("search merge preserves file order and expansion-aware matches without searching the selected patch", () => {
  const files = [
    { filename: "b.ts", patch: PATCH },
    { filename: "a.ts", patch: PATCH },
  ];
  const patches = searchPatches(files, "line", { excludeFilename: "b.ts" });
  expect(patches.every((match) => match.filename === "a.ts")).toBe(true);
  const row = {
    rowIndex: 50,
    side: "new" as const,
    oldLine: 99,
    newLine: 100,
    start: 0,
    length: 4,
  };
  const matches = mergeSearchMatches(files, "b.ts", [row], patches);
  expect(matches[0]).toEqual({ filename: "b.ts", ...row });
  expect(
    matches
      .slice(1)
      .map((match) => [
        match.filename,
        match.side,
        match.oldLine,
        match.newLine,
      ])
  ).toEqual([
    ["a.ts", "old", 2, null],
    ["a.ts", "new", null, 2],
  ]);
  expect(mergeSearchMatches([], null, [], [])).toEqual([]);
});

test("walkPatchLines tracks line numbers from hunk headers", () => {
  expect(walkPatchLines(PATCH)).toEqual([
    { kind: "context", oldLine: 1, newLine: 1, text: "context" },
    { kind: "delete", oldLine: 2, newLine: null, text: "removed line" },
    { kind: "insert", oldLine: null, newLine: 2, text: "added line" },
  ]);
});

test("walkPatchLines handles multi-line hunks and ignores metadata", () => {
  const patch = `diff --git a/f b/f
index 123..456 100644
--- a/f
+++ b/f
@@ -10,2 +10,2 @@
 keep
-old
+new
\\ No newline at end of file`;
  expect(walkPatchLines(patch)).toEqual([
    { kind: "context", oldLine: 10, newLine: 10, text: "keep" },
    { kind: "delete", oldLine: 11, newLine: null, text: "old" },
    { kind: "insert", oldLine: null, newLine: 11, text: "new" },
  ]);
});

test("searchPatches finds matches across files in order", () => {
  const files = [
    { filename: "a.ts", patch: PATCH },
    {
      filename: "b.ts",
      patch: `@@ -5,1 +5,1 @@
-some line here
`,
    },
  ];
  expect(searchPatches(files, "line")).toEqual([
    {
      filename: "a.ts",
      kind: "delete",
      oldLine: 2,
      newLine: null,
      start: 8,
      length: 4,
    },
    {
      filename: "a.ts",
      kind: "insert",
      oldLine: null,
      newLine: 2,
      start: 6,
      length: 4,
    },
    {
      filename: "b.ts",
      kind: "delete",
      oldLine: 5,
      newLine: null,
      start: 5,
      length: 4,
    },
  ]);
});

test("searchPatches is case-insensitive by default and skips patchless files", () => {
  const files = [
    { filename: "binary.bin" },
    {
      filename: "a.ts",
      patch: `@@ -1,1 +1,1 @@
+Added Line
`,
    },
  ];
  expect(searchPatches(files, "added line")).toEqual([
    {
      filename: "a.ts",
      kind: "insert",
      oldLine: null,
      newLine: 1,
      start: 0,
      length: 10,
    },
  ]);
  expect(searchPatches(files, "zzz")).toEqual([]);
});

function row(
  type: string,
  values: string[],
  oldLine?: number | null,
  newLine?: number | null
) {
  return {
    type: "line",
    line: {
      type,
      content: values.map((value) => ({ value, type })),
      oldLineNumber: oldLine ?? null,
      newLineNumber: newLine ?? null,
    },
  };
}

test("searchRows matches unified rows and reports the right side", () => {
  const rows = [
    row("normal", ["const x = 1;"], 1, 1),
    row("delete", ["const x = 2;"], 2),
    { type: "skip", hunk: {} },
    row("insert", ["const y = 3;"], null, 3),
  ];
  const matches = searchRows(rows as never, "const");
  expect(matches.map((m) => [m.rowIndex, m.side, m.start])).toEqual([
    [0, "new", 0],
    [1, "old", 0],
    [3, "new", 0],
  ]);
});

test("searchRows skips collapsed blocks and non-code rows", () => {
  const rows = [
    { type: "skip", hunk: {} },
    { type: "comment-thread", comments: [] },
    row("normal", ["needle here"], 5, 5),
  ];
  const matches = searchRows(rows as never, "needle");
  expect(matches).toEqual([
    { rowIndex: 2, side: "new", oldLine: 5, newLine: 5, start: 0, length: 6 },
  ]);
});

test("searchRows searches both spaces of merged modified rows", () => {
  const merged = {
    type: "line",
    line: {
      type: "normal",
      oldLineNumber: 7,
      newLineNumber: 7,
      content: [
        { value: "line_index", type: "normal" },
        { value: "raise ", type: "insert" },
        { value: "= i", type: "delete" },
        { value: "e", type: "insert" },
      ],
    },
  };
  // new-space: "line_index" + "raise " + "e"
  expect(searchRows([merged] as never, "raise")).toEqual([
    { rowIndex: 0, side: "new", oldLine: 7, newLine: 7, start: 10, length: 5 },
  ]);
  // old-space: "line_index" + "= i"
  expect(searchRows([merged] as never, "= i")).toEqual([
    { rowIndex: 0, side: "old", oldLine: 7, newLine: 7, start: 10, length: 3 },
  ]);
});

test("mapRangeToSegments maps side-space ranges onto segments", () => {
  const segments = [
    { value: "line_index", type: "normal" },
    { value: "raise ", type: "insert" },
    { value: "= i", type: "delete" },
    { value: "e", type: "insert" },
  ];
  // new-space = "line_indexraise e": [5, 13) spans two segments
  expect(mapRangeToSegments(segments, "new", 5, 8)).toEqual([
    { segIndex: 0, start: 5, length: 5 },
    { segIndex: 1, start: 0, length: 3 },
  ]);
  // old-space = "line_index= i": [0, 10) is exactly the first segment
  expect(mapRangeToSegments(segments, "old", 0, 10)).toEqual([
    { segIndex: 0, start: 0, length: 10 },
  ]);
  expect(mapRangeToSegments(segments, "old", 0, 7)).not.toBeNull();
});
