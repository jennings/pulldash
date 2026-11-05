import { expect, test } from "bun:test";
import type { PRCommit } from "@/browser/contexts/github";
import { diffRows } from "@/browser/lib/file-diff";
import {
  buildMetadataComparison,
  buildMetadataLines,
  buildSingleCommitDiff,
  getCommitFieldLabel,
} from "./useCurrentDiff";

function commit(sha: string, message: string): PRCommit {
  return {
    sha,
    parents: [{ sha: "parent" }],
    commit: {
      message,
      author: { name: "Ada", email: "ada@example.com" },
    },
  } as unknown as PRCommit;
}

const texts = (diff: ReturnType<typeof buildSingleCommitDiff>) =>
  diffRows(diff.fileDiff).map((row) => (row.kind === "gap" ? "gap" : row.text));

test("the :commit pseudo-file shows the metadata lines as unchanged context", () => {
  const head = commit("abc", "Subject\n\nBody line");
  const diff = buildSingleCommitDiff(head, "change-1");
  const lines = buildMetadataLines(head, "change-1").map((line) => line.raw);
  expect(texts(diff)).toEqual(lines);
  expect(lines[0]).toBe("Commit: abc");
  expect(lines).toContain("Change-Id: change-1");
  expect(lines).toContain("Subject");
  expect(diff.fileDiff.name).toBe(":commit");
  expect(diff.fileDiff.lang).toBe("text");
  expect(diffRows(diff.fileDiff).every((row) => row.kind === "line")).toBe(
    true
  );
  // Line numbers line up with the labels comments are anchored by.
  const rows = diffRows(diff.fileDiff);
  const subjectLine =
    rows.findIndex((row) => row.kind === "line" && row.text === "Subject") + 1;
  expect(getCommitFieldLabel(subjectLine, head, "change-1")).toBe("Subject");
});

test("the metadata cache key changes with the content", () => {
  const a = buildSingleCommitDiff(commit("abc", "One"));
  const b = buildSingleCommitDiff(commit("abc", "Two"));
  const again = buildSingleCommitDiff(commit("abc", "One"));
  expect(a.fileDiff.cacheKey).toBe(again.fileDiff.cacheKey);
  expect(a.fileDiff.cacheKey).not.toBe(b.fileDiff.cacheKey);
});

test("comparing two versions of a commit diffs their metadata with head's line numbers", () => {
  const prev = commit("old", "Subject\n\nfirst body");
  const head = commit("new", "Subject\n\nsecond body");
  const diff = buildMetadataComparison(prev, head);
  const rows = diffRows(diff.fileDiff);
  const changed = rows.filter(
    (row) => row.kind === "line" && row.type !== "context"
  );
  expect(
    changed.map((row) => row.kind === "line" && [row.type, row.text])
  ).toEqual(
    expect.arrayContaining([
      ["deletion", "Commit: old"],
      ["addition", "Commit: new"],
      ["deletion", "first body"],
      ["addition", "second body"],
    ])
  );
  const headLines = buildMetadataLines(head).map((line) => line.raw);
  for (const row of rows) {
    if (row.kind !== "line" || row.newLine === null) continue;
    expect(row.text).toBe(headLines[row.newLine - 1]!);
  }
});

test("identical metadata gives back the identical diff object", () => {
  const same = () => buildSingleCommitDiff(commit("abc", "One"), "change-1");
  expect(same()).toBe(same());
  expect(buildSingleCommitDiff(commit("abc", "One"), "other")).not.toBe(same());
  const compare = () =>
    buildMetadataComparison(commit("old", "A"), commit("new", "B"));
  expect(compare()).toBe(compare());
});
