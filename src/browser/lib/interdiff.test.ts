import { test, expect, describe } from "bun:test";
import { computeInterdiff, buildPostImageLines } from "./interdiff";
import { escapeHtml, hastToHtml } from "../../shared/diff-utils";
import type { DiffHunk } from "./diff-worker";
import type { RootContent } from "hast";

describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  test("escapes less-than and greater-than", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("escapes multiple special chars in one string", () => {
    expect(escapeHtml('<a href="x&y">z</a>')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;z&lt;/a&gt;"
    );
  });
});

describe("hastToHtml", () => {
  test("converts text node to escaped html", () => {
    const node: RootContent = { type: "text", value: "hello & world" };
    expect(hastToHtml(node)).toBe("hello &amp; world");
  });

  test("converts element node with no class", () => {
    const node: RootContent = {
      type: "element",
      tagName: "span",
      properties: {},
      children: [{ type: "text", value: "code" }],
    };
    expect(hastToHtml(node)).toBe("<span>code</span>");
  });

  test("converts element node with className", () => {
    const node: RootContent = {
      type: "element",
      tagName: "span",
      properties: { className: ["token", "keyword"] },
      children: [{ type: "text", value: "const" }],
    };
    expect(hastToHtml(node)).toBe('<span class="token keyword">const</span>');
  });

  test("handles nested elements", () => {
    const node: RootContent = {
      type: "element",
      tagName: "span",
      properties: { className: ["outer"] },
      children: [
        {
          type: "element",
          tagName: "em",
          properties: {},
          children: [{ type: "text", value: "inner" }],
        },
      ],
    };
    expect(hastToHtml(node)).toBe('<span class="outer"><em>inner</em></span>');
  });

  test("returns empty string for unknown node types", () => {
    const node = { type: "doctype" } as unknown as RootContent;
    expect(hastToHtml(node)).toBe("");
  });
});

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

  test("v2 adds a second hunk that v1 did not touch", () => {
    // v1: changes line 10 only (3 lines of context each side)
    const patch1 = `@@ -7,7 +7,7 @@
 ctx7
 ctx8
 ctx9
-old10
+new10v1
 ctx11
 ctx12
 ctx13`;

    // v2: changes line 10 differently AND adds line 15
    // GitHub merges these into one big hunk (lines 7-18)
    const patch2 = `@@ -7,12 +7,13 @@
 ctx7
 ctx8
 ctx9
-old10
+new10v2
 ctx11
 ctx12
 ctx13
 ctx14
+new15
 ctx16
 ctx17
 ctx18`;

    const result = computeInterdiff(patch1, patch2);

    // Must have at least one hunk
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);

    const allLines = hunks.flatMap((h) => h.lines);
    const insertLines = allLines.filter((l) => l.type === "insert");
    const deleteLines = allLines.filter((l) => l.type === "delete");

    // The change at line 10 shows as a modify (delete + insert)
    expect(deleteLines.some((l) => l.oldLineNumber === 10)).toBe(true);
    expect(insertLines.some((l) => l.newLineNumber === 10)).toBe(true);

    // The new line 15 shows as an insert
    expect(insertLines.some((l) => l.newLineNumber === 15)).toBe(true);

    // Context lines 11-14 (shared between v1 and v2) must NOT be shown as inserts
    for (const n of [11, 12, 13, 14]) {
      expect(insertLines.some((l) => l.newLineNumber === n)).toBe(false);
    }
  });

  test("inline-and-shift: lines shifted by a deletion above are not marked changed", () => {
    // v1: commit adds a helper function (HELPER_DEF, HELPER_BODY, HELPER_END)
    // and changes the call site from OLD_CALL to CALL_HELPER.
    // v2: inlines the helper — helper function removed, call site changed to
    // INLINE_BODY.  PREAMBLE, MAIN_START, MAIN_END, AFTER are context in both.
    const patch1 = `@@ -1,5 +1,8 @@
 PREAMBLE
+HELPER_DEF
+HELPER_BODY
+HELPER_END
 MAIN_START
-OLD_CALL
+CALL_HELPER
 MAIN_END
 AFTER`;

    const patch2 = `@@ -1,5 +1,4 @@
 PREAMBLE
 MAIN_START
-OLD_CALL
+INLINE_BODY
 MAIN_END
 AFTER`;

    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);

    const allLines = hunks.flatMap((h) => h.lines);
    const insertLines = allLines.filter((l) => l.type === "insert");
    const deleteLines = allLines.filter((l) => l.type === "delete");

    // Helper function lines from v1 should be deleted
    const deletedContents = deleteLines.map((l) =>
      l.content.map((s) => s.value).join("")
    );
    expect(deletedContents.some((c) => c.includes("HELPER_DEF"))).toBe(true);
    expect(deletedContents.some((c) => c.includes("CALL_HELPER"))).toBe(true);

    // The inlined body should be inserted
    const insertedContents = insertLines.map((l) =>
      l.content.map((s) => s.value).join("")
    );
    expect(insertedContents.some((c) => c.includes("INLINE_BODY"))).toBe(true);

    // Shared context lines must NOT appear as inserts
    expect(
      insertLines.some((l) =>
        l.content.some(
          (s) =>
            s.value.includes("PREAMBLE") ||
            s.value.includes("MAIN_START") ||
            s.value.includes("MAIN_END") ||
            s.value.includes("AFTER")
        )
      )
    ).toBe(false);
  });

  test("deletion above shared block: shared block stays equal, not delete+insert", () => {
    // v1: adds block A (lines 1-3) and block B (lines 5-7)
    const patch1 = `@@ -1,6 +1,8 @@
 intro
+blockA_line1
+blockA_line2
 gap
+blockB_line1
+blockB_line2
 outro`;

    // v2: only adds block B (block A was removed in this revision)
    const patch2 = `@@ -1,3 +1,5 @@
 intro
 gap
+blockB_line1
+blockB_line2
 outro`;

    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);

    const allLines = hunks.flatMap((h) => h.lines);
    const insertLines = allLines.filter((l) => l.type === "insert");
    const deleteLines = allLines.filter((l) => l.type === "delete");

    // block A should show as deleted
    const deletedContents = deleteLines.map((l) =>
      l.content.map((s) => s.value).join("")
    );
    expect(deletedContents.some((c) => c.includes("blockA_line1"))).toBe(true);
    expect(deletedContents.some((c) => c.includes("blockA_line2"))).toBe(true);

    // block B is shared by both post-images; must NOT appear as delete or insert
    expect(
      deleteLines.some((l) => l.content.some((s) => s.value.includes("blockB")))
    ).toBe(false);
    expect(
      insertLines.some((l) => l.content.some((s) => s.value.includes("blockB")))
    ).toBe(false);
  });
});
