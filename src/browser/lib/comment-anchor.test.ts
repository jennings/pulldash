import { test, expect, describe } from "bun:test";
import {
  commitShasMatch,
  resolveCommentLine,
  resolveCommentLineFromDiffHunk,
} from "./comment-anchor";
import { fileDiffFromPatch, type LoadedDiff } from "./file-diff";

/** Build a diff from hunks written as raw patch lines (`+`, `-`, ` ` prefixed). */
function diffOf(
  ...hunks: { oldStart: number; newStart: number; lines: string[] }[]
): LoadedDiff {
  const patch = hunks
    .map(({ oldStart, newStart, lines }) => {
      const oldCount = lines.filter((l) => l[0] !== "+").length;
      const newCount = lines.filter((l) => l[0] !== "-").length;
      return [
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...lines,
      ].join("\n");
    })
    .join("\n");
  return { fileDiff: fileDiffFromPatch({ patch, filename: "file.ts" }) };
}

test("comparison comment coordinates belong to the displayed source commit", () => {
  const diff: LoadedDiff = {
    ...diffOf(),
    sources: {
      old: { sha: "previous", path: "file" },
      new: { sha: "current", path: "file" },
    },
  };
  expect(
    resolveCommentLine(
      { side: "LEFT", commitId: "previous", line: 50 },
      "current",
      diff
    )
  ).toBe(50);
  expect(
    resolveCommentLine(
      { side: "LEFT", commitId: "current", line: 50 },
      "current",
      diff
    )
  ).toBeNull();
  expect(
    resolveCommentLine(
      { side: "RIGHT", commitId: "current", line: 60 },
      "current",
      diff
    )
  ).toBe(60);
});

describe("commitShasMatch", () => {
  test("matches identical full SHAs", () => {
    expect(commitShasMatch("abc123def", "abc123def")).toBe(true);
  });

  test("matches when short is a prefix of full", () => {
    expect(commitShasMatch("abc123d", "abc123def456")).toBe(true);
    expect(commitShasMatch("abc123def456", "abc123d")).toBe(true);
  });

  test("does not match different SHAs", () => {
    expect(commitShasMatch("abc1234", "def5678")).toBe(false);
  });

  test("returns false for null/undefined inputs", () => {
    expect(commitShasMatch(null, "abc")).toBe(false);
    expect(commitShasMatch("abc", undefined)).toBe(false);
    expect(commitShasMatch(null, null)).toBe(false);
  });
});

describe("resolveCommentLineFromDiffHunk", () => {
  test("re-anchors a multi-line RIGHT-side comment to its content's new line", () => {
    // Comment was on lines 194-195 of an older commit ("sleep = ...; };").
    // In the new view, the same content lives at lines 199-200.
    const diffHunk = [
      "@@ -10,3 +180,21 @@",
      "+        tokio::time::sleep(sleep).await;",
      "+        sleep = std::cmp::min(sleep.saturating_mul(2), max_sleep);",
      "+    };",
    ].join("\n");

    const diff = diffOf({
      oldStart: 100,
      newStart: 195,
      lines: [
        "+        let (slot_index, lock) = loop {",
        "+            if let Some(found) = something() {",
        "+                break found;",
        "+            }",
        "+            tokio::time::sleep(sleep).await;",
        "+        sleep = std::cmp::min(sleep.saturating_mul(2), max_sleep);",
        "+    };",
      ],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 195, startLine: 194, diffHunk },
      diff
    );
    expect(line).toBe(201);
  });

  test("returns the original line number when content is unchanged", () => {
    const diffHunk = ["@@ -10,3 +50,3 @@", "+foo", "+bar", "+baz"].join("\n");

    const diff = diffOf({
      oldStart: 10,
      newStart: 50,
      lines: ["+foo", "+bar", "+baz"],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 52, startLine: 52, diffHunk },
      diff
    );
    expect(line).toBe(52);
  });

  test("returns null when the anchored content was removed in the new view", () => {
    const diffHunk = [
      "@@ -10,3 +50,3 @@",
      "+removed1",
      "+removed2",
      "+removed3",
    ].join("\n");

    const diff = diffOf({
      oldStart: 10,
      newStart: 50,
      lines: ["+other1", "+other2"],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 52, startLine: 52, diffHunk },
      diff
    );
    expect(line).toBeNull();
  });

  test("uses extra context lines to disambiguate generic anchor content", () => {
    // Comment on a single line with very generic content ("};") that appears
    // twice in the diff. Surrounding context must pick the right occurrence.
    const diffHunk = [
      "@@ -10,5 +50,5 @@",
      "+unique-marker-A",
      "+inner-stuff",
      "+};",
    ].join("\n");

    const diff = diffOf({
      oldStart: 10,
      newStart: 50,
      lines: [
        "+unique-marker-B",
        "+other-stuff",
        "+};",
        "+padding",
        "+unique-marker-A",
        "+inner-stuff",
        "+};",
      ],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 100, startLine: 100, diffHunk },
      diff
    );
    expect(line).toBe(56);
  });

  test("falls back to anchor-only match when context lines do not match", () => {
    const diffHunk = [
      "@@ -10,3 +50,3 @@",
      "+context-changed-A",
      "+context-changed-B",
      "+target-line",
    ].join("\n");

    const diff = diffOf({
      oldStart: 10,
      newStart: 70,
      lines: [
        "+totally-different-context-1",
        "+totally-different-context-2",
        "+target-line",
      ],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 100, startLine: 100, diffHunk },
      diff
    );
    expect(line).toBe(72);
  });

  test("matches LEFT-side comments against deleted/normal lines", () => {
    const diffHunk = [
      "@@ -50,3 +10,3 @@",
      "-removed-A",
      "-removed-B",
      "-removed-C",
    ].join("\n");

    const diff = diffOf({
      oldStart: 80,
      newStart: 10,
      lines: ["-removed-A", "-removed-B", "-removed-C", "+added-line"],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "LEFT", line: 52, startLine: 50, diffHunk },
      diff
    );
    expect(line).toBe(82);
  });

  test("does not match across a collapsed gap between hunks", () => {
    const diffHunk = ["@@ -10,2 +50,2 @@", "+alpha", "+beta"].join("\n");

    const split = diffOf(
      { oldStart: 10, newStart: 50, lines: ["+alpha"] },
      { oldStart: 40, newStart: 81, lines: ["+beta"] }
    );
    expect(
      resolveCommentLineFromDiffHunk(
        { side: "RIGHT", line: 100, startLine: 99, diffHunk },
        split
      )
    ).toBeNull();

    // The leading gap before the hunk is skipped, not searched.
    const gapped = diffOf({
      oldStart: 10,
      newStart: 50,
      lines: ["+alpha", "+beta"],
    });
    expect(
      resolveCommentLineFromDiffHunk(
        { side: "RIGHT", line: 100, startLine: 99, diffHunk },
        gapped
      )
    ).toBe(51);
  });

  test("matches across context lines (LCS-style normal entries)", () => {
    const diffHunk = ["@@ -10,2 +50,2 @@", " context-x", "+inserted-y"].join(
      "\n"
    );

    const diff = diffOf({
      oldStart: 200,
      newStart: 300,
      lines: [" context-x", "+inserted-y", "+trailing"],
    });

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 75, startLine: 75, diffHunk },
      diff
    );
    expect(line).toBe(301);
  });

  test("returns null when diffHunk is missing or empty", () => {
    const diff = diffOf();
    expect(
      resolveCommentLineFromDiffHunk(
        { side: "RIGHT", line: 10, diffHunk: null },
        diff
      )
    ).toBeNull();
    expect(
      resolveCommentLineFromDiffHunk(
        { side: "RIGHT", line: 10, diffHunk: "" },
        diff
      )
    ).toBeNull();
  });
});

describe("resolveCommentLine", () => {
  const diff = diffOf({
    oldStart: 1,
    newStart: 50,
    lines: ["+alpha", "+beta"],
  });
  const comment = {
    commitId: "aaaa1111ffff",
    originalCommitId: "bbbb2222ffff",
    line: 55,
    originalLine: 51,
    side: "RIGHT" as const,
    diffHunk: "@@ -1,2 +50,2 @@\n+alpha\n+beta",
  };

  test("uses line when viewing the comment's commit_id", () => {
    expect(resolveCommentLine(comment, "aaaa1111ffff", diff)).toBe(55);
  });

  test("uses originalLine when viewing the original_commit_id", () => {
    expect(resolveCommentLine(comment, "bbbb2222ffff", diff)).toBe(51);
  });

  test("matches short SHA prefixes", () => {
    expect(resolveCommentLine(comment, "aaaa111", diff)).toBe(55);
    expect(resolveCommentLine(comment, "bbbb222", diff)).toBe(51);
  });

  test("re-anchors by content for unrelated commits", () => {
    expect(resolveCommentLine(comment, "cccc3333ffff", diff)).toBe(51);
  });

  test("falls back to line when no commit ids are present", () => {
    expect(
      resolveCommentLine(
        { commitId: null, originalCommitId: null, line: 7 },
        "aaaa1111ffff",
        diff
      )
    ).toBe(7);
  });
});
