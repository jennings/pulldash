import { expect, test } from "bun:test";
import { hydratePartialDiff } from "@pierre/diffs";
import { gotoLineTarget, navItems, splitItems } from "./diff-navigation";
import { diffRows, fileDiffFromPatch } from "./file-diff";

const PATCH = [
  "@@ -1,6 +1,6 @@",
  " a",
  "-b1",
  "-b2",
  "+B1",
  "+B2",
  "+B3",
  " c",
  "-d",
  " e",
  "@@ -40,2 +40,3 @@",
  " x",
  "+y",
  " z",
].join("\n");

const rows = () =>
  diffRows(fileDiffFromPatch({ patch: PATCH, filename: "f.ts" }));

test("navItems: deleted lines focus the old side, everything else the new side", () => {
  expect(navItems(rows())).toEqual([
    { type: "line", lineNum: 1, side: "new" },
    { type: "line", lineNum: 2, side: "old" },
    { type: "line", lineNum: 3, side: "old" },
    { type: "line", lineNum: 2, side: "new" },
    { type: "line", lineNum: 3, side: "new" },
    { type: "line", lineNum: 4, side: "new" },
    { type: "line", lineNum: 5, side: "new" },
    { type: "line", lineNum: 5, side: "old" },
    { type: "line", lineNum: 6, side: "new" },
    { type: "gap", hunkIndex: 1 },
    { type: "line", lineNum: 40, side: "new" },
    { type: "line", lineNum: 41, side: "new" },
    { type: "line", lineNum: 42, side: "new" },
  ]);
});

test("splitItems pairs deletions with additions by position", () => {
  expect(splitItems(rows())).toEqual([
    { type: "pair", oldLine: 1, newLine: 1 },
    { type: "pair", oldLine: 2, newLine: 2 },
    { type: "pair", oldLine: 3, newLine: 3 },
    { type: "pair", oldLine: null, newLine: 4 },
    { type: "pair", oldLine: 4, newLine: 5 },
    { type: "pair", oldLine: 5, newLine: null },
    { type: "pair", oldLine: 6, newLine: 6 },
    { type: "gap", hunkIndex: 1 },
    { type: "pair", oldLine: 40, newLine: 40 },
    { type: "pair", oldLine: null, newLine: 41 },
    { type: "pair", oldLine: 41, newLine: 42 },
  ]);
});

test("gotoLineTarget finds the closest line in the typed column", () => {
  const all = rows();
  // New column: 7 is closest to the new line 6 (ties keep the first).
  expect(gotoLineTarget(all, 7, "new", "unified")).toEqual({
    line: 6,
    side: "new",
  });
  expect(gotoLineTarget(all, 100, "new", "unified")).toEqual({
    line: 42,
    side: "new",
  });
  // Old column: line 5 is deleted, focused on the old side...
  expect(gotoLineTarget(all, 5, "old", "unified")).toEqual({
    line: 5,
    side: "old",
  });
  // ...but old line 4 is the context "c", which unified focuses on the new side
  // and split focuses on the column the user picked.
  expect(gotoLineTarget(all, 4, "old", "unified")).toEqual({
    line: 5,
    side: "new",
  });
  expect(gotoLineTarget(all, 4, "old", "split")).toEqual({
    line: 4,
    side: "old",
  });
  expect(gotoLineTarget([], 1, "new", "unified")).toBeNull();
});

test("hidden gap lines are not goto targets even when the file is hydrated", () => {
  const diff = hydratePartialDiff(
    "clone",
    fileDiffFromPatch({
      patch: "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -30,1 +30,1 @@\n-c\n+d",
      filename: "f.ts",
    }),
    {
      oldFile: {
        name: "f.ts",
        contents: ["a", ...Array(28).fill("m"), "c"].join("\n") + "\n",
      },
      newFile: {
        name: "f.ts",
        contents: ["b", ...Array(28).fill("m"), "d"].join("\n") + "\n",
      },
    }
  );
  expect(gotoLineTarget(diffRows(diff), 15, "new", "unified")).toEqual({
    line: 1,
    side: "new",
  });
});
