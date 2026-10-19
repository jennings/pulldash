import { expect, test } from "bun:test";
import { expandComparisonContext } from "./diff-expansion";
import { compareFileContents, highlightFileLines } from "./diff-parser";

test("comparison expansion loads both versions and preserves unequal ranges", async () => {
  const calls: string[] = [];
  const rows = await expandComparisonContext(
    {
      type: "skip",
      count: 2,
      content: "",
      oldStart: 2,
      newStart: 3,
      oldCount: 1,
      newCount: 2,
    },
    { old: { sha: "old", path: "before" }, new: { sha: "new", path: "after" } },
    async (path, sha) => {
      calls.push(`${path}@${sha}`);
      return sha === "old"
        ? "prefix\nold value\nend\n"
        : "prefix\nextra\nnew value\nadded\nend\n";
    },
    async (...args) => compareFileContents(...args),
    async (...args) => highlightFileLines(...args)
  );
  expect(calls).toEqual(["before@old", "after@new"]);
  expect(rows.flatMap((line) => line.oldLineNumber ?? [])).toEqual([2]);
  expect(rows.flatMap((line) => line.newLineNumber ?? [])).toEqual([3, 4]);
  const side = (old: boolean) =>
    rows
      .filter((line) => line.type !== (old ? "insert" : "delete"))
      .map((line) =>
        line.content
          .filter((s) => s.type !== (old ? "insert" : "delete"))
          .map((s) => s.value)
          .join("")
      );
  expect(side(true)).toEqual(["old value"]);
  expect(side(false)).toEqual(["new value", "added"]);
});
