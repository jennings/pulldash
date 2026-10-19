import { expect, test } from "bun:test";
import { parseDiffWithHighlighting } from "./diff-parser";

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
