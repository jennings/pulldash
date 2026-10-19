import { expect, test } from "bun:test";
import { parseDiffWithHighlighting, compareFileContents } from "./diff-parser";

test("complete-content comparison reconstructs both sides including repeated replacements", () => {
  const old = "shared\nkeep\nbase\n";
  const current = "base\nkeep\nshared\n";
  const lines = compareFileContents(
    old,
    current,
    "file.txt",
    Infinity
  ).hunks.flatMap((h) => (h.type === "hunk" ? h.lines : []));
  for (const [content, excluded] of [
    [old, "insert"],
    [current, "delete"],
  ] as const) {
    expect(
      lines
        .filter((line) => line.type !== excluded)
        .map((line) =>
          line.content
            .filter((s) => s.type !== excluded)
            .map((s) => s.value)
            .join("")
        )
        .join("\n") + "\n"
    ).toBe(content);
  }
});

test("leading deletions remain before following context and preserve both files", () => {
  const result = parseDiffWithHighlighting(
    "@@ -1,7 +1,4 @@\n-base_1\n-base_2\n-base_3\n base_4\n base_5\n base_6\n base_7",
    "file.txt"
  );
  const lines = result.hunks.flatMap((h) => (h.type === "hunk" ? h.lines : []));
  expect(lines.flatMap((line) => line.oldLineNumber ?? [])).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(lines.flatMap((line) => line.newLineNumber ?? [])).toEqual([
    1, 2, 3, 4,
  ]);
  expect(
    lines
      .filter((line) => line.type !== "insert")
      .map((line) => line.content.map((s) => s.value).join(""))
  ).toEqual(Array.from({ length: 7 }, (_, i) => `base_${i + 1}`));
});
