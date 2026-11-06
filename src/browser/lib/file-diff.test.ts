import { expect, test } from "bun:test";
import { hydratePartialDiff } from "@pierre/diffs";
import {
  baseDiffRows,
  comparisonContentsProblem,
  reconstructPreImage,
  comparisonLoadedDiff,
  contextOnlyFileDiff,
  diffRows,
  emptyLoadedDiff,
  fileDiffFromPatch,
  hashText,
  windowPatchAroundLines,
  type DiffExpansion,
  type DiffRow,
} from "./file-diff";

const MODIFIED = [
  "@@ -1,3 +1,4 @@ function foo",
  " keep",
  "-old line",
  "+new line",
  "+extra line",
  " tail",
].join("\n");

test("modified file: hunk numbers and line text come from the hunk-only patch", () => {
  const diff = fileDiffFromPatch({
    patch: MODIFIED,
    filename: "src/foo.ts",
    cacheKey: "foo-1",
  });
  expect(diff.name).toBe("src/foo.ts");
  expect(diff.prevName).toBeUndefined();
  expect(diff.type).toBe("change");
  expect(diff.cacheKey).toBe("foo-1");
  expect(diff.hunks).toHaveLength(1);
  const [hunk] = diff.hunks;
  expect(hunk).toMatchObject({
    deletionStart: 1,
    deletionCount: 3,
    additionStart: 1,
    additionCount: 4,
    deletionLines: 1,
    additionLines: 2,
  });
  expect(diff.deletionLines.map((l) => l.trimEnd())).toEqual([
    "keep",
    "old line",
    "tail",
  ]);
  expect(diff.additionLines.map((l) => l.trimEnd())).toEqual([
    "keep",
    "new line",
    "extra line",
    "tail",
  ]);
});

test("hunk header context is preserved as hunkContext", () => {
  const diff = fileDiffFromPatch({ patch: MODIFIED, filename: "a.ts" });
  expect(diff.hunks[0]!.hunkContext).toBe("function foo");
});

test("added file with status added is a new file", () => {
  const diff = fileDiffFromPatch({
    patch: "@@ -0,0 +1,2 @@\n+one\n+two",
    filename: "new.ts",
    status: "added",
  });
  expect(diff.type).toBe("new");
  expect(diff.name).toBe("new.ts");
  expect(diff.deletionLines).toEqual([]);
  expect(diff.additionLines.map((l) => l.trimEnd())).toEqual(["one", "two"]);
});

test("removed file with status removed is a deleted file", () => {
  const diff = fileDiffFromPatch({
    patch: "@@ -1,2 +0,0 @@\n-one\n-two",
    filename: "gone.ts",
    status: "removed",
  });
  expect(diff.type).toBe("deleted");
  expect(diff.additionLines).toEqual([]);
});

test("renamed file keeps the previous name, with and without content changes", () => {
  const changed = fileDiffFromPatch({
    patch: MODIFIED,
    filename: "src/new-name.ts",
    previousFilename: "src/old-name.ts",
    status: "renamed",
  });
  expect(changed.name).toBe("src/new-name.ts");
  expect(changed.prevName).toBe("src/old-name.ts");
  expect(changed.type).toBe("rename-changed");
  expect(changed.hunks).toHaveLength(1);

  const pure = fileDiffFromPatch({
    patch: "",
    filename: "b.ts",
    previousFilename: "a.ts",
    status: "renamed",
  });
  expect(pure.type).toBe("rename-pure");
  expect(pure.prevName).toBe("a.ts");
  expect(pure.hunks).toEqual([]);
});

test("a copied file is an ordinary change to the new path, not a rename", () => {
  const changed = fileDiffFromPatch({
    patch: MODIFIED,
    filename: "src/copy.ts",
    previousFilename: "src/original.ts",
    status: "copied",
  });
  expect(changed.type).toBe("change");
  expect(changed.name).toBe("src/copy.ts");
  expect(changed.prevName).toBeUndefined();
  expect(changed.hunks).toHaveLength(1);

  const pure = fileDiffFromPatch({
    patch: "",
    filename: "b.ts",
    previousFilename: "a.ts",
    status: "copied",
  });
  expect(pure.type).toBe("change");
  expect(pure.name).toBe("b.ts");
  expect(pure.hunks).toEqual([]);
});

test("file names with spaces survive the synthesized header", () => {
  const diff = fileDiffFromPatch({
    patch: MODIFIED,
    filename: "docs/my file.md",
  });
  expect(diff.name).toBe("docs/my file.md");
  expect(diff.hunks).toHaveLength(1);
});

test("a missing trailing newline is recorded on the hunk", () => {
  const diff = fileDiffFromPatch({
    patch: [
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
    ].join("\n"),
    filename: "eof.txt",
  });
  const [hunk] = diff.hunks;
  expect(hunk!.noEOFCRDeletions).toBe(true);
  expect(hunk!.noEOFCRAdditions).toBe(true);
  expect(diff.additionLines.map((l) => l.trimEnd())).toEqual(["keep", "new"]);
});

test("empty and blank patches give a diff with no hunks", () => {
  for (const patch of ["", "  \n"]) {
    const diff = fileDiffFromPatch({
      patch,
      filename: "bin.png",
      cacheKey: "k",
    });
    expect(diff.name).toBe("bin.png");
    expect(diff.hunks).toEqual([]);
    expect(diff.cacheKey).toBe("k");
  }
});

const THREAD_HUNK = [
  "@@ -10,8 +10,9 @@ class A",
  " a",
  " b",
  " c",
  " d",
  " e",
  "-removed",
  "+added one",
  "+added two",
  " f",
  " g",
].join("\n");

test("windowing keeps four lines of context before the comment through its line", () => {
  // New-file numbers: a=10 b=11 c=12 d=13 e=14 added one=15 added two=16 f=17
  const windowed = windowPatchAroundLines(THREAD_HUNK, { line: 16 });
  expect(windowed).toBe(
    [
      "@@ -12,4 +12,5 @@ class A",
      " c",
      " d",
      " e",
      "-removed",
      "+added one",
      "+added two",
    ].join("\n")
  );
});

test("windowing a multi-line range starts the context before the range start", () => {
  const windowed = windowPatchAroundLines(THREAD_HUNK, {
    line: 15,
    startLine: 14,
  });
  expect(windowed.split("\n")).toEqual([
    "@@ -10,6 +10,6 @@ class A",
    " a",
    " b",
    " c",
    " d",
    " e",
    "-removed",
    "+added one",
  ]);
});

test("windowing renumbers a hunk that keeps only additions", () => {
  const patch = ["@@ -5,1 +5,3 @@", " ctx", "+x", "+y"].join("\n");
  // Only the added lines (6, 7) fall in the window; the old side is empty and
  // is numbered by the line before the insertion.
  expect(windowPatchAroundLines(patch, { line: 7, startLine: 6 }, 0)).toBe(
    "@@ -5,0 +6,2 @@\n+x\n+y"
  );
});

test("windowing keeps the whole hunk, with a corrected header, without a line or a match", () => {
  // GitHub cuts diff_hunk at the commented line but keeps the full hunk's counts.
  const truncated = "@@ -1,9 +1,9 @@ fn\n a\n-b\n+c";
  const whole = "@@ -1,2 +1,2 @@ fn\n a\n-b\n+c";
  expect(windowPatchAroundLines(truncated, { line: null })).toBe(whole);
  expect(windowPatchAroundLines(truncated, { line: 500 })).toBe(whole);
  expect(windowPatchAroundLines("not a hunk", { line: 3 })).toBe("not a hunk");
});

test("windowing keeps the no-newline marker with the last kept line", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "\\ No newline at end of file",
  ].join("\n");
  expect(windowPatchAroundLines(patch, { line: 2 }).split("\n")).toEqual([
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "\\ No newline at end of file",
  ]);
});

// Old file: L1..L32. New file: L5 -> L5x, L20 removed, "extra" added after L28.
const OLD_LINES = Array.from({ length: 32 }, (_, i) => `L${i + 1}`);
const NEW_LINES = OLD_LINES.flatMap((line) =>
  line === "L5"
    ? ["L5x"]
    : line === "L20"
      ? []
      : line === "L28"
        ? [line, "extra"]
        : [line]
);
const MULTI_HUNK_PATCH = [
  "@@ -2,7 +2,7 @@",
  " L2",
  " L3",
  " L4",
  "-L5",
  "+L5x",
  " L6",
  " L7",
  " L8",
  "@@ -17,7 +17,6 @@",
  " L17",
  " L18",
  " L19",
  "-L20",
  " L21",
  " L22",
  " L23",
  "@@ -26,5 +25,6 @@",
  " L26",
  " L27",
  " L28",
  "+extra",
  " L29",
  " L30",
].join("\n");

const multiHunkDiff = () =>
  fileDiffFromPatch({ patch: MULTI_HUNK_PATCH, filename: "multi.ts" });

const hydrated = () =>
  hydratePartialDiff("clone", multiHunkDiff(), {
    oldFile: { name: "multi.ts", contents: OLD_LINES.join("\n") + "\n" },
    newFile: { name: "multi.ts", contents: NEW_LINES.join("\n") + "\n" },
  });

/** Compact rendering: `old|new text`, `+new text`, `-old text`, `gap(count)`. */
const show = (rows: DiffRow[]) =>
  rows.map((row) => {
    if (row.kind === "gap")
      return `gap#${row.hunkIndex}(${row.count})@${row.oldStart}/${row.newStart}`;
    if (row.type === "addition") return `+${row.newLine} ${row.text}`;
    if (row.type === "deletion") return `-${row.oldLine} ${row.text}`;
    return `${row.oldLine}|${row.newLine} ${row.text}`;
  });

test("diffRows of a partial diff: numbered lines in unified order with gaps between hunks", () => {
  const rows = diffRows(multiHunkDiff());
  expect(show(rows)).toEqual([
    "gap#0(1)@1/1",
    "2|2 L2",
    "3|3 L3",
    "4|4 L4",
    "-5 L5",
    "+5 L5x",
    "6|6 L6",
    "7|7 L7",
    "8|8 L8",
    "gap#1(8)@9/9",
    "17|17 L17",
    "18|18 L18",
    "19|19 L19",
    "-20 L20",
    "21|20 L21",
    "22|21 L22",
    "23|22 L23",
    "gap#2(2)@24/23",
    "26|25 L26",
    "27|26 L27",
    "28|27 L28",
    "+28 extra",
    "29|29 L29",
    "30|30 L30",
  ]);
  expect(rows.filter((r) => r.kind === "line").map((r) => r.hunkIndex)).toEqual(
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]
  );
});

test("diffRows of a hydrated diff: small gaps are shown, large ones and the trailing region collapse", () => {
  const diff = hydrated();
  expect(diff.isPartial).toBe(false);
  expect(show(diffRows(diff))).toEqual([
    "1|1 L1",
    "2|2 L2",
    "3|3 L3",
    "4|4 L4",
    "-5 L5",
    "+5 L5x",
    "6|6 L6",
    "7|7 L7",
    "8|8 L8",
    "gap#1(8)@9/9",
    "17|17 L17",
    "18|18 L18",
    "19|19 L19",
    "-20 L20",
    "21|20 L21",
    "22|21 L22",
    "23|22 L23",
    "gap#2(2)@24/23",
    "26|25 L26",
    "27|26 L27",
    "28|27 L28",
    "+28 extra",
    "29|29 L29",
    "30|30 L30",
    "gap#3(2)@31/31",
  ]);
});

test("diffRows splits a gap when it is partially expanded from both ends", () => {
  const expansion: DiffExpansion = new Map([
    [1, { fromStart: 2, fromEnd: 3 }],
    [3, { fromStart: 1, fromEnd: 0 }],
  ]);
  const text = show(diffRows(hydrated(), expansion));
  const gap = text.findIndex((row) => row.startsWith("gap#1"));
  expect(text.slice(gap - 3, gap + 5)).toEqual([
    "8|8 L8",
    "9|9 L9",
    "10|10 L10",
    "gap#1(3)@11/11",
    "14|14 L14",
    "15|15 L15",
    "16|16 L16",
    "17|17 L17",
  ]);
  expect(text.slice(-2)).toEqual(["31|31 L31", "gap#3(1)@32/32"]);
});

test("diffRows turns a fully expanded gap into context rows only", () => {
  const diff = hydrated();
  const expansion: DiffExpansion = new Map([
    [1, { fromStart: 8, fromEnd: 0 }],
    [2, { fromStart: 1, fromEnd: 1 }],
    [3, { fromStart: 2, fromEnd: 0 }],
  ]);
  const rows = diffRows(diff, expansion);
  expect(rows.some((row) => row.kind === "gap")).toBe(false);
  // Every line of both files appears exactly once: unified shows deletions
  // and additions on their own rows.
  expect(rows).toHaveLength(diff.unifiedLineCount);
  expect(rows.at(-1)).toMatchObject({ oldLine: 32, newLine: 32, text: "L32" });
});

test("diffRows ignores expansion of a partial diff", () => {
  const expansion: DiffExpansion = new Map([[1, { fromStart: 8, fromEnd: 0 }]]);
  expect(diffRows(multiHunkDiff(), expansion)).toEqual(
    diffRows(multiHunkDiff())
  );
});

test("diffRows handles pure additions, pure deletions and a new file", () => {
  const added = fileDiffFromPatch({
    patch: "@@ -0,0 +1,2 @@\n+one\n+two",
    filename: "new.ts",
    status: "added",
  });
  expect(show(diffRows(added))).toEqual(["+1 one", "+2 two"]);
  const removed = fileDiffFromPatch({
    patch: "@@ -1,2 +0,0 @@\n-one\n-two",
    filename: "gone.ts",
    status: "removed",
  });
  expect(show(diffRows(removed))).toEqual(["-1 one", "-2 two"]);
  const insertion = fileDiffFromPatch({
    patch: "@@ -3,0 +4,1 @@\n+inserted",
    filename: "x.ts",
  });
  expect(show(diffRows(insertion))).toEqual(["gap#0(3)@1/1", "+4 inserted"]);
});

test("diffRows of a diff without hunks is empty", () => {
  expect(
    diffRows(fileDiffFromPatch({ patch: "", filename: "bin.png" }))
  ).toEqual([]);
});

test("a hunk that ends the file leaves no trailing gap even when hydrated", () => {
  const diff = hydratePartialDiff(
    "clone",
    fileDiffFromPatch({
      patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c",
      filename: "t.ts",
    }),
    {
      oldFile: { name: "t.ts", contents: "a\nb\n" },
      newFile: { name: "t.ts", contents: "a\nc\n" },
    }
  );
  expect(show(diffRows(diff))).toEqual(["1|1 a", "-2 b", "+2 c"]);
});

test("contextOnlyFileDiff shows every line as unchanged context", () => {
  const diff = contextOnlyFileDiff("meta.txt", "alpha\n\ngamma\n", {
    cacheKey: "meta-1",
  });
  expect(diff.cacheKey).toBe("meta-1");
  expect(diff.hunks).toHaveLength(1);
  expect(show(diffRows(diff))).toEqual(["1|1 alpha", "2|2 ", "3|3 gamma"]);
  expect(diffRows(contextOnlyFileDiff("empty.txt", ""))).toEqual([]);
});

test("hashText is stable, short and sensitive to every character", () => {
  expect(hashText("abc")).toBe(hashText("abc"));
  expect(hashText("abc")).not.toBe(hashText("abd"));
  expect(hashText("abc")).not.toBe(hashText("abc "));
  expect(hashText("")).not.toBe(hashText(" "));
  expect(hashText("x".repeat(100_000)).length).toBeLessThan(15);
});

test("emptyLoadedDiff has no hunks and carries the error and sources", () => {
  const sources = {
    old: { sha: "a", path: "f.ts" },
    new: { sha: "b", path: "f.ts" },
  };
  expect(emptyLoadedDiff("f.ts")).toMatchObject({ fileDiff: { name: "f.ts" } });
  const failed = emptyLoadedDiff("f.ts", { error: "nope", sources });
  expect(failed.error).toBe("nope");
  expect(failed.sources).toBe(sources);
  expect(failed.fileDiff.hunks).toEqual([]);
});

test("comparisonLoadedDiff keeps sources and keys Pierre's cache by version and content", () => {
  const sources = {
    old: { sha: "old", path: "a.ts", exists: true },
    new: { sha: "new", path: "a.ts", exists: true },
  };
  const patch = "@@ -3,1 +3,1 @@\n-x\n+y";
  const diff = comparisonLoadedDiff(patch, "a.ts", sources);
  expect(diff.sources).toBe(sources);
  expect(diff.fileDiff.type).toBe("change");
  expect(diff.fileDiff.hunks).toHaveLength(1);
  const key = diff.fileDiff.cacheKey;
  expect(key).toBeDefined();
  expect(comparisonLoadedDiff(patch, "a.ts", sources).fileDiff.cacheKey).toBe(
    key
  );
  expect(
    comparisonLoadedDiff(patch + "z", "a.ts", sources).fileDiff.cacheKey
  ).not.toBe(key);
  expect(
    comparisonLoadedDiff(patch, "a.ts", {
      ...sources,
      new: { ...sources.new, sha: "newer" },
    }).fileDiff.cacheKey
  ).not.toBe(key);
});

test("a comparison where a side does not exist is an added or removed file", () => {
  const patch = "@@ -0,0 +1,1 @@\n+hello";
  const added = comparisonLoadedDiff(patch, "a.ts", {
    old: { sha: "old", path: "a.ts", exists: false },
    new: { sha: "new", path: "a.ts", exists: true },
  });
  expect(added.fileDiff.type).toBe("new");
  const removed = comparisonLoadedDiff("@@ -1,1 +0,0 @@\n-hello", "a.ts", {
    old: { sha: "old", path: "a.ts", exists: true },
    new: { sha: "new", path: "a.ts", exists: false },
  });
  expect(removed.fileDiff.type).toBe("deleted");
});

// Pre-image: a b c d e f g h i j. Post-image: line c rewritten, d deleted, "x"
// added after g, and the file ends without a trailing newline on "j".
const PRE = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
const POST = ["a", "b", "C", "e", "f", "g", "x", "h", "i", "j"];
const PRE_POST_PATCH = [
  "@@ -2,4 +2,3 @@",
  " b",
  "-c",
  "-d",
  "+C",
  " e",
  "@@ -7,2 +6,3 @@",
  " g",
  "+x",
  " h",
].join("\n");
const text = (lines: string[]) => lines.join("\n") + "\n";
const prePostDiff = () =>
  fileDiffFromPatch({ patch: PRE_POST_PATCH, filename: "t.ts" });

test("reconstructPreImage undoes the hunks on the post-image", () => {
  expect(reconstructPreImage(prePostDiff(), text(POST))).toBe(text(PRE));
});

test("reconstructPreImage keeps a missing final newline and CRLF endings", () => {
  const diff = fileDiffFromPatch({
    patch: [
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+B",
      "\\ No newline at end of file",
    ].join("\n"),
    filename: "t.ts",
  });
  expect(reconstructPreImage(diff, "a\nB")).toBe("a\nb");
  const crlf = fileDiffFromPatch({
    patch: "@@ -1,2 +1,2 @@\n a\r\n-b\r\n+B\r\n",
    filename: "t.ts",
  });
  expect(reconstructPreImage(crlf, "a\r\nB\r\nrest\r\n")).toBe(
    "a\r\nb\r\nrest\r\n"
  );
});

test("reconstructPreImage refuses text that is not the diff's post-image", () => {
  // A line the patch says is added or context is different.
  expect(
    reconstructPreImage(
      prePostDiff(),
      text(POST.map((l) => (l === "x" ? "y" : l)))
    )
  ).toBeNull();
  // A shifted file.
  expect(reconstructPreImage(prePostDiff(), text(["z", ...POST]))).toBeNull();
  // Too short to contain the hunks.
  expect(reconstructPreImage(prePostDiff(), "a\nb\n")).toBeNull();
  // Already hydrated.
  const hydrated = prePostDiff();
  hydratePartialDiff("merge", hydrated, {
    oldFile: { name: "t.ts", contents: text(PRE) },
    newFile: { name: "t.ts", contents: text(POST) },
  });
  expect(reconstructPreImage(hydrated, text(POST))).toBeNull();
});

test("a reconstructed pre-image hydrates to the diff's own lines", () => {
  const diff = prePostDiff();
  const oldContents = reconstructPreImage(diff, text(POST))!;
  hydratePartialDiff("merge", diff, {
    oldFile: { name: "t.ts", contents: oldContents },
    newFile: { name: "t.ts", contents: text(POST) },
  });
  const rows = diffRows(diff);
  expect(
    rows.map((row) =>
      row.kind === "gap" ? `gap${row.count}` : `${row.type[0]}:${row.text}`
    )
  ).toEqual([
    "c:a",
    "c:b",
    "d:c",
    "d:d",
    "a:C",
    "c:e",
    "c:f",
    "c:g",
    "a:x",
    "c:h",
    "gap2",
  ]);
});

test("comparisonContentsProblem accepts fitting versions with equal gaps", () => {
  expect(
    comparisonContentsProblem(prePostDiff(), text(PRE), text(POST))
  ).toBeNull();
});

test("comparisonContentsProblem rejects versions that do not fit the hunks", () => {
  expect(
    comparisonContentsProblem(
      prePostDiff(),
      text(PRE.map((l) => (l === "d" ? "D" : l))),
      text(POST)
    )
  ).toContain("old version");
  expect(
    comparisonContentsProblem(
      prePostDiff(),
      text(PRE),
      text(POST.map((l) => (l === "C" ? "c" : l)))
    )
  ).toContain("new version");
});

test("comparisonContentsProblem rejects gaps and tails of different length", () => {
  // Same hunks, but the old version has two extra lines between them...
  const shifted = fileDiffFromPatch({
    patch: [
      "@@ -2,2 +2,2 @@",
      " b",
      "-c",
      "+C",
      "@@ -9,1 +6,1 @@",
      "-g",
      "+G",
    ].join("\n"),
    filename: "t.ts",
  });
  const old = text(["a", "b", "c", "d", "e", "f", "x", "y", "g", "h"]);
  const now = text(["a", "b", "C", "d", "e", "G", "h"]);
  expect(comparisonContentsProblem(shifted, old, now)).toContain(
    "between hunks"
  );
  // ...or an extra line after the last hunk.
  const tail = fileDiffFromPatch({
    patch: "@@ -2,1 +2,1 @@\n-c\n+C",
    filename: "t.ts",
  });
  expect(
    comparisonContentsProblem(
      tail,
      text(["a", "c", "d", "e"]),
      text(["a", "C", "d"])
    )
  ).toContain("after the last hunk");
});

test("baseDiffRows is computed once per diff and again after hydration", () => {
  const diff = prePostDiff();
  const partial = baseDiffRows(diff);
  expect(baseDiffRows(diff)).toBe(partial);
  hydratePartialDiff("merge", diff, {
    oldFile: { name: "t.ts", contents: text(PRE) },
    newFile: { name: "t.ts", contents: text(POST) },
  });
  const hydrated = baseDiffRows(diff);
  expect(hydrated).not.toBe(partial);
  expect(baseDiffRows(diff)).toBe(hydrated);
});
