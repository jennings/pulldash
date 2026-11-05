import { expect, test } from "bun:test";
import { fileDiffFromPatch, windowPatchAroundLines } from "./file-diff";

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
