import { test, expect, describe } from "bun:test";
import {
  commitShasMatch,
  resolveCommentLineFromDiffHunk,
} from "./comment-anchor";
import type { ParsedDiff, DiffLine } from "./diff-worker";

function normal(content: string, oldLine: number, newLine: number): DiffLine {
  return {
    type: "normal",
    oldLineNumber: oldLine,
    newLineNumber: newLine,
    content: [{ value: content, html: content, type: "normal" }],
  };
}

function insert(content: string, newLine: number): DiffLine {
  return {
    type: "insert",
    newLineNumber: newLine,
    content: [{ value: content, html: content, type: "insert" }],
  };
}

function deleteLine(content: string, oldLine: number): DiffLine {
  return {
    type: "delete",
    oldLineNumber: oldLine,
    content: [{ value: content, html: content, type: "delete" }],
  };
}

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

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 100,
          newStart: 195,
          lines: [
            insert("        let (slot_index, lock) = loop {", 195),
            insert("            if let Some(found) = something() {", 196),
            insert("                break found;", 197),
            insert("            }", 198),
            insert("            tokio::time::sleep(sleep).await;", 199),
            insert(
              "        sleep = std::cmp::min(sleep.saturating_mul(2), max_sleep);",
              200
            ),
            insert("    };", 201),
          ],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 195, startLine: 194, diffHunk },
      parsedDiff
    );
    expect(line).toBe(201);
  });

  test("returns the original line number when content is unchanged", () => {
    const diffHunk = ["@@ -10,3 +50,3 @@", "+foo", "+bar", "+baz"].join("\n");

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 10,
          newStart: 50,
          lines: [insert("foo", 50), insert("bar", 51), insert("baz", 52)],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 52, startLine: 52, diffHunk },
      parsedDiff
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

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 10,
          newStart: 50,
          lines: [insert("other1", 50), insert("other2", 51)],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 52, startLine: 52, diffHunk },
      parsedDiff
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

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 10,
          newStart: 50,
          lines: [
            insert("unique-marker-B", 50),
            insert("other-stuff", 51),
            insert("};", 52),
            insert("padding", 53),
            insert("unique-marker-A", 60),
            insert("inner-stuff", 61),
            insert("};", 62),
          ],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 100, startLine: 100, diffHunk },
      parsedDiff
    );
    expect(line).toBe(62);
  });

  test("falls back to anchor-only match when context lines do not match", () => {
    const diffHunk = [
      "@@ -10,3 +50,3 @@",
      "+context-changed-A",
      "+context-changed-B",
      "+target-line",
    ].join("\n");

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 10,
          newStart: 50,
          lines: [
            insert("totally-different-context-1", 70),
            insert("totally-different-context-2", 71),
            insert("target-line", 72),
          ],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 100, startLine: 100, diffHunk },
      parsedDiff
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

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 80,
          newStart: 10,
          lines: [
            deleteLine("removed-A", 80),
            deleteLine("removed-B", 81),
            deleteLine("removed-C", 82),
            insert("added-line", 10),
          ],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "LEFT", line: 52, startLine: 50, diffHunk },
      parsedDiff
    );
    expect(line).toBe(82);
  });

  test("ignores skip blocks when searching for matches", () => {
    const diffHunk = ["@@ -10,2 +50,2 @@", "+alpha", "+beta"].join("\n");

    const parsedDiff: ParsedDiff = {
      hunks: [
        { type: "skip", count: 30, content: "" },
        {
          type: "hunk",
          oldStart: 10,
          newStart: 50,
          lines: [insert("alpha", 50), insert("beta", 51)],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 100, startLine: 99, diffHunk },
      parsedDiff
    );
    expect(line).toBe(51);
  });

  test("matches across context lines (LCS-style normal entries)", () => {
    const diffHunk = ["@@ -10,2 +50,2 @@", " context-x", "+inserted-y"].join(
      "\n"
    );

    const parsedDiff: ParsedDiff = {
      hunks: [
        {
          type: "hunk",
          oldStart: 200,
          newStart: 300,
          lines: [
            normal("context-x", 200, 300),
            insert("inserted-y", 301),
            insert("trailing", 302),
          ],
        },
      ],
    };

    const line = resolveCommentLineFromDiffHunk(
      { side: "RIGHT", line: 75, startLine: 75, diffHunk },
      parsedDiff
    );
    expect(line).toBe(301);
  });

  test("returns null when diffHunk is missing or empty", () => {
    const parsedDiff: ParsedDiff = { hunks: [] };
    expect(
      resolveCommentLineFromDiffHunk(
        { side: "RIGHT", line: 10, diffHunk: null },
        parsedDiff
      )
    ).toBeNull();
    expect(
      resolveCommentLineFromDiffHunk(
        { side: "RIGHT", line: 10, diffHunk: "" },
        parsedDiff
      )
    ).toBeNull();
  });
});
