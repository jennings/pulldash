import { test, expect, describe } from "bun:test";
import { computeInterdiff, buildPostImageLines } from "./interdiff";
import type { DiffHunk } from "./diff-worker";

describe("buildPostImageLines", () => {
  test("returns empty array for empty patch", () => {
    expect(buildPostImageLines("")).toEqual([]);
  });

  test("returns context and insert lines, not delete lines", () => {
    const patch = `@@ -1,4 +1,4 @@
 context1
 context2
-old_line
+new_line
 context3`;
    const lines = buildPostImageLines(patch);
    // gitdiff-parser strips the leading +/-/space marker from content
    expect(lines).toContain("context1");
    expect(lines).toContain("context2");
    expect(lines).toContain("new_line");
    expect(lines).not.toContain("old_line");
    expect(lines).toContain("context3");
  });
});

describe("computeInterdiff", () => {
  test("identical patches produce empty output", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old_line
+new_line
 context`;
    const result = computeInterdiff(patch, patch);
    expect(result.hunks).toHaveLength(0);
  });

  test("real change in v2 produces non-empty diff", () => {
    const patch1 = `@@ -1,3 +1,3 @@
 context
-old_line
+v1_line
 context`;
    const patch2 = `@@ -1,3 +1,3 @@
 context
-old_line
+v2_line
 context`;
    const result = computeInterdiff(patch1, patch2);
    expect(result.hunks.length).toBeGreaterThan(0);
    const hunk = result.hunks.find((h) => h.type === "hunk") as DiffHunk;
    expect(hunk).toBeDefined();
    const hasDelete = hunk.lines.some((l) => l.type === "delete");
    const hasInsert = hunk.lines.some((l) => l.type === "insert");
    expect(hasDelete).toBe(true);
    expect(hasInsert).toBe(true);
  });

  test("rebase-only shift produces empty output", () => {
    // Same change but at different line positions due to rebase
    const patch1 = `@@ -10,5 +10,5 @@
 ctx1
 ctx2
-old
+new
 ctx3
 ctx4`;
    const patch2 = `@@ -20,5 +20,5 @@
 ctx1
 ctx2
-old
+new
 ctx3
 ctx4`;
    const result = computeInterdiff(patch1, patch2);
    // Both post-images have identical content lines → no diff
    expect(result.hunks).toHaveLength(0);
  });

  test("additional lines in v2 show as insertions", () => {
    const patch1 = `@@ -1,2 +1,3 @@
 context
-old
+v1_new
 context`;
    const patch2 = `@@ -1,2 +1,4 @@
 context
-old
+v2_new_line_a
+v2_new_line_b
 context`;
    const result = computeInterdiff(patch1, patch2);
    expect(result.hunks.length).toBeGreaterThan(0);
    const hunk = result.hunks.find((h) => h.type === "hunk") as DiffHunk;
    const insertLines = hunk.lines.filter((l) => l.type === "insert");
    expect(insertLines.length).toBeGreaterThanOrEqual(1);
  });

  test("empty patches produce empty output", () => {
    const result = computeInterdiff("", "");
    expect(result.hunks).toHaveLength(0);
  });
});
