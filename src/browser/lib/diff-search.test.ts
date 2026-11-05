import { test, expect } from "bun:test";
import { hydratePartialDiff } from "@pierre/diffs";
import {
  mergeSearchMatches,
  searchPatches,
  searchRows,
  walkPatchLines,
  type DiffSearchMatch,
} from "./diff-search";
import { diffRows, fileDiffFromPatch } from "./file-diff";

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
  const row: DiffSearchMatch = {
    side: "new",
    lineNumber: 100,
    start: 0,
    end: 4,
    hunkIndex: 3,
    inGap: true,
  };
  const matches = mergeSearchMatches(files, "b.ts", [row], patches);
  expect(matches[0]).toEqual({ filename: "b.ts", ...row });
  expect(
    matches
      .slice(1)
      .map((match) => [match.filename, match.side, match.lineNumber])
  ).toEqual([
    ["a.ts", "old", 2],
    ["a.ts", "new", 2],
  ]);
  expect(mergeSearchMatches([], null, [], [])).toEqual([]);
});

test("walkPatchLines tracks line numbers and hunk ordinals from hunk headers", () => {
  expect(walkPatchLines(PATCH)).toEqual([
    { kind: "context", oldLine: 1, newLine: 1, text: "context", hunkIndex: 0 },
    {
      kind: "delete",
      oldLine: 2,
      newLine: null,
      text: "removed line",
      hunkIndex: 0,
    },
    {
      kind: "insert",
      oldLine: null,
      newLine: 2,
      text: "added line",
      hunkIndex: 0,
    },
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
\\ No newline at end of file
@@ -30,1 +30,1 @@
-second`;
  expect(walkPatchLines(patch)).toEqual([
    { kind: "context", oldLine: 10, newLine: 10, text: "keep", hunkIndex: 0 },
    { kind: "delete", oldLine: 11, newLine: null, text: "old", hunkIndex: 0 },
    { kind: "insert", oldLine: null, newLine: 11, text: "new", hunkIndex: 0 },
    {
      kind: "delete",
      oldLine: 30,
      newLine: null,
      text: "second",
      hunkIndex: 1,
    },
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
      side: "old",
      lineNumber: 2,
      start: 8,
      end: 12,
      hunkIndex: 0,
      inGap: false,
    },
    {
      filename: "a.ts",
      side: "new",
      lineNumber: 2,
      start: 6,
      end: 10,
      hunkIndex: 0,
      inGap: false,
    },
    {
      filename: "b.ts",
      side: "old",
      lineNumber: 5,
      start: 5,
      end: 9,
      hunkIndex: 0,
      inGap: false,
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
      side: "new",
      lineNumber: 1,
      start: 0,
      end: 10,
      hunkIndex: 0,
      inGap: false,
    },
  ]);
  expect(searchPatches(files, "zzz")).toEqual([]);
  expect(searchPatches(files, "added line", { caseSensitive: true })).toEqual(
    []
  );
});

const ROWS_PATCH = [
  "@@ -1,3 +1,3 @@",
  " const x = 1;",
  "-const x = 2;",
  "+const y = 3;",
  " tail",
  "@@ -20,1 +20,2 @@",
  " needle here",
  "+needle there",
].join("\n");

test("searchRows matches unified rows and reports the right side", () => {
  const diff = fileDiffFromPatch({ patch: ROWS_PATCH, filename: "a.ts" });
  const matches = searchRows(diffRows(diff), "const");
  expect(
    matches.map((m) => [m.side, m.lineNumber, m.start, m.end, m.hunkIndex])
  ).toEqual([
    ["new", 1, 0, 5, 0],
    ["old", 2, 0, 5, 0],
    ["new", 2, 0, 5, 0],
  ]);
  expect(matches.every((m) => !m.inGap)).toBe(true);
});

test("searchRows does not see text hidden in a gap of a partial diff", () => {
  const diff = fileDiffFromPatch({ patch: ROWS_PATCH, filename: "a.ts" });
  expect(searchRows(diffRows(diff), "never-shown")).toEqual([]);
  expect(
    searchRows(diffRows(diff), "needle").map((m) => [m.lineNumber, m.hunkIndex])
  ).toEqual([
    [20, 1],
    [21, 1],
  ]);
});

test("searchRows searches collapsed gaps once the file is hydrated", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  lines[9] = "hidden needle";
  const oldLines = [...lines];
  const newLines = [...lines];
  oldLines[0] = "first";
  newLines[0] = "FIRST";
  oldLines[29] = "last";
  newLines[29] = "LAST";
  const diff = hydratePartialDiff(
    "clone",
    fileDiffFromPatch({
      patch: [
        "@@ -1,2 +1,2 @@",
        "-first",
        "+FIRST",
        " line 2",
        "@@ -29,2 +29,2 @@",
        " line 29",
        "-last",
        "+LAST",
      ].join("\n"),
      filename: "a.ts",
    }),
    {
      oldFile: { name: "a.ts", contents: oldLines.join("\n") + "\n" },
      newFile: { name: "a.ts", contents: newLines.join("\n") + "\n" },
    }
  );
  const rows = diffRows(diff);
  expect(searchRows(rows, "hidden")).toEqual([]);
  expect(searchRows(rows, "hidden", { fileDiff: diff })).toEqual([
    {
      side: "new",
      lineNumber: 10,
      start: 0,
      end: 6,
      hunkIndex: 1,
      inGap: true,
    },
  ]);
  // Once expanded the same line is an ordinary row match.
  const expanded = diffRows(
    diff,
    new Map([[1, { fromStart: 27, fromEnd: 0 }]])
  );
  expect(searchRows(expanded, "hidden", { fileDiff: diff })).toEqual([
    {
      side: "new",
      lineNumber: 10,
      start: 0,
      end: 6,
      hunkIndex: 1,
      inGap: false,
    },
  ]);
});
