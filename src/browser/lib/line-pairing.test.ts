import { expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { fileDiffFromPatch } from "./file-diff";

const patchOf = (oldStart: number, newStart: number, lines: string[]) =>
  [
    `@@ -${oldStart},${lines.filter((l) => l[0] !== "+").length} +${newStart},${lines.filter((l) => l[0] !== "-").length} @@`,
    ...lines,
  ].join("\n");

/** Change blocks of each hunk as `-deletions+additions`, context as `cN`. */
const shape = (patch: string, parse = fileDiffFromPatch) =>
  parse({ patch, filename: "file.txt" }).hunks.map((h) =>
    h.hunkContent
      .map((c) =>
        c.type === "context" ? `c${c.lines}` : `-${c.deletions}+${c.additions}`
      )
      .join(" ")
  );

const pierreOnly = ({ patch }: { patch: string }) =>
  parsePatchFiles(`--- a/file.txt\n+++ b/file.txt\n${patch}\n`)[0]!.files[0]!;

test("an unmatched line in the middle of a run gets its own block", () => {
  expect(
    shape(
      patchOf(1, 1, [
        " c",
        "-hello world",
        "+hello_world",
        "-standalone",
        "-foo bar",
        "+foo baz",
        " c",
      ])
    )
  ).toEqual(["c1 -1+1 -1+0 -1+1 c1"]);
});

test("unrelated lines keep Pierre's positional pairing", () => {
  const patch = patchOf(1, 1, ["-apple", "-banana", "+cherry", "+date", " c"]);
  expect(shape(patch)).toEqual(shape(patch, pierreOnly));
  expect(shape(patch)).toEqual(["-2+2 c1"]);
});

test("blank lines do not pair with each other across unrelated lines", () => {
  expect(
    shape(
      patchOf(1, 1, ["-alpha", "-", "-beta", "+one", "+two", "+", "+three"])
    )
  ).toEqual(["-3+4"]);
});

test("consecutive similar pairs stay one block", () => {
  expect(
    shape(patchOf(1, 1, ["-x", "-foo(1)", "-bar(1)", "+foo(2)", "+bar(2)"]))
  ).toEqual(["-1+0 -2+2"]);
});

test("later hunks move down by the rows the pairing adds", () => {
  const patch = [
    patchOf(1, 1, ["-call_one(a)", "-other", "+inserted", "+call_one(b)"]),
    patchOf(20, 20, ["-z", "+zz"]),
  ].join("\n");
  const paired = fileDiffFromPatch({ patch, filename: "file.txt" });
  const plain = pierreOnly({ patch });
  expect(paired.hunks[0]!.splitLineCount).toBe(3);
  expect(plain.hunks[0]!.splitLineCount).toBe(2);
  expect(paired.hunks[1]!.splitLineStart).toBe(
    plain.hunks[1]!.splitLineStart + 1
  );
  expect(paired.splitLineCount).toBe(plain.splitLineCount + 1);
  expect(paired.unifiedLineCount).toBe(plain.unifiedLineCount);
});

test("very large runs keep Pierre's pairing", () => {
  const n = 501;
  const patch = patchOf(1, 1, [
    ...Array.from({ length: n }, (_, i) => `-line ${i}`),
    ...Array.from({ length: n }, (_, i) => `+line ${i + 1}!`),
  ]);
  expect(shape(patch)).toEqual(shape(patch, pierreOnly));
});
