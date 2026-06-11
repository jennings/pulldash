import { test, expect, describe } from "bun:test";
import { parseDiff, mergeModifiedLines } from "./parse";
import { INLINE_MAX_CHAR_EDITS } from "../../../../diff-parse-constants";
import type { ParseOptions } from "./parse";
import type { Change } from "gitdiff-parser";

const defaultOpts: ParseOptions = {
  maxDiffDistance: 30,
  maxChangeRatio: 0.45,
  mergeModifiedLines: true,
  inlineMaxCharEdits: INLINE_MAX_CHAR_EDITS,
};

// ============================================================================
// Helpers
// ============================================================================

function makeDiff(body: string): string {
  return `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
${body}`;
}

// ============================================================================
// mergeModifiedLines
// ============================================================================

describe("mergeModifiedLines", () => {
  function makeDelete(lineNumber: number, content: string): Change {
    return { type: "delete", lineNumber, content } as Change;
  }
  function makeInsert(lineNumber: number, content: string): Change {
    return { type: "insert", lineNumber, content } as Change;
  }
  function makeNormal(lineNumber: number, content: string): Change {
    return { type: "normal", lineNumber, oldLineNumber: lineNumber, newLineNumber: lineNumber, content } as any;
  }

  test("returns empty array for empty changes", () => {
    expect(mergeModifiedLines([], defaultOpts)).toEqual([]);
  });

  test("normal lines pass through unchanged", () => {
    const changes = [makeNormal(1, "same line")];
    const result = mergeModifiedLines(changes, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("normal");
  });

  test("merges similar delete+insert into a single normal line with inline diff", () => {
    const changes = [
      makeDelete(1, "foo bar"),
      makeInsert(1, "foo baz"),
    ];
    const result = mergeModifiedLines(changes, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("normal");
    const merged = result[0] as any;
    expect(merged.oldLineNumber).toBe(1);
    expect(merged.newLineNumber).toBe(1);
    // Content should have multiple segments (inline diff)
    expect(result[0].content.length).toBeGreaterThan(1);
  });

  test("does not merge delete+insert pairs that exceed maxChangeRatio", () => {
    const opts: ParseOptions = { ...defaultOpts, maxChangeRatio: 0.1 };
    const changes = [
      makeDelete(1, "hello world"),
      makeInsert(1, "completely different text"),
    ];
    const result = mergeModifiedLines(changes, opts);
    // Too different to merge — each line emitted separately
    expect(result).toHaveLength(2);
  });

  test("does not merge lines beyond maxDiffDistance", () => {
    const opts: ParseOptions = { ...defaultOpts, maxDiffDistance: 1 };
    const changes = [
      makeDelete(1, "foo"),
      makeNormal(2, "context"),
      makeNormal(3, "context"),
      makeNormal(4, "context"),
      makeInsert(10, "foo"),
    ];
    const result = mergeModifiedLines(changes, opts);
    // 5 changes all pass through unmerged
    expect(result).toHaveLength(5);
    // Delete at line 1 and insert at line 10 are NOT merged into a single normal line
    const merged = (result as any[]).find((l) => l.oldLineNumber === 1 && l.newLineNumber === 10);
    expect(merged).toBeUndefined();
    // They come out as their original types
    const types = result.map((l) => l.type);
    expect(types[0]).toBe("delete");
    expect(types[4]).toBe("insert");
  });

  test("unpaired delete emits as its original type", () => {
    const changes = [makeDelete(1, "orphan delete")];
    const result = mergeModifiedLines(changes, defaultOpts);
    expect(result).toHaveLength(1);
    // emitNormal wraps it as-is, keeping delete type
    expect(result[0].type).toBe("delete");
  });

  test("unpaired insert emits as its original type", () => {
    const changes = [makeInsert(1, "orphan insert")];
    const result = mergeModifiedLines(changes, defaultOpts);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("insert");
  });
});

// ============================================================================
// parseHunk (tested via parseDiff)
// ============================================================================

describe("parseHunk (via parseDiff)", () => {
  test("parses a hunk with mixed change types", () => {
    const diff = makeDiff(`@@ -1,3 +1,3 @@
 context
-old
+new
 context`);
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    const hunk = files[0].hunks.find((h) => h.type === "hunk");
    expect(hunk?.type).toBe("hunk");
    if (hunk?.type === "hunk") {
      expect(hunk.lines.length).toBeGreaterThan(0);
    }
  });

  test("mergeModifiedLines=false leaves delete and insert separate", () => {
    const diff = makeDiff(`@@ -1,2 +1,2 @@
-foo
+foo bar`);
    const files = parseDiff(diff, { mergeModifiedLines: false });
    const hunk = files[0].hunks.find((h) => h.type === "hunk");
    if (hunk?.type === "hunk") {
      const types = hunk.lines.map((l) => l.type);
      expect(types).toContain("delete");
      expect(types).toContain("insert");
    }
  });

  test("mergeModifiedLines=true merges similar adjacent lines", () => {
    const diff = makeDiff(`@@ -1,2 +1,2 @@
-foo bar
+foo baz`);
    const files = parseDiff(diff, { mergeModifiedLines: true });
    const hunk = files[0].hunks.find((h) => h.type === "hunk");
    if (hunk?.type === "hunk") {
      const merged = (hunk.lines as any[]).find(
        (l) => l.type === "normal" && l.oldLineNumber !== undefined && l.newLineNumber !== undefined
      );
      expect(merged).toBeDefined();
    }
  });
});

// ============================================================================
// insertSkipBlocks (tested via parseDiff)
// ============================================================================

describe("insertSkipBlocks (via parseDiff)", () => {
  test("no skip block when hunks are contiguous from line 1", () => {
    const diff = makeDiff(`@@ -1,3 +1,3 @@
 context
-old
+new
 context`);
    const files = parseDiff(diff);
    const skip = files[0].hunks.find((h) => h.type === "skip");
    expect(skip).toBeUndefined();
  });

  test("inserts a skip block between non-adjacent hunks", () => {
    const diff = makeDiff(`@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,3 @@
 x
-y
+Y
 z`);
    const files = parseDiff(diff);
    const skip = files[0].hunks.find((h) => h.type === "skip");
    expect(skip).toBeDefined();
    if (skip?.type === "skip") {
      expect(skip.count).toBeGreaterThan(0);
    }
  });

  test("skip block count equals the gap between hunks", () => {
    // First hunk ends at line 3, second starts at line 10 → gap of 7
    const diff = makeDiff(`@@ -1,3 +1,3 @@
 line1
-line2
+line2x
 line3
@@ -10,3 +10,3 @@
 line10
-line11
+line11x
 line12`);
    const files = parseDiff(diff);
    const skip = files[0].hunks.find((h) => h.type === "skip");
    expect(skip?.type).toBe("skip");
    if (skip?.type === "skip") {
      expect(skip.count).toBe(6); // 10 - 4 = 6 (lastHunkLine = oldStart(1) + oldLines(3) = 4)
    }
  });

  test("skip block uses hunk context from header", () => {
    const diff = makeDiff(`@@ -1,2 +1,2 @@
-a
+A
 b
@@ -20,2 +20,2 @@ function foo() {
-x
+X
 y`);
    const files = parseDiff(diff);
    const skip = files[0].hunks.find((h) => h.type === "skip");
    if (skip?.type === "skip") {
      expect(skip.content).toBe("function foo() {");
    }
  });
});

// ============================================================================
// calculateChangeRatio (tested via mergeModifiedLines behavior)
// ============================================================================

describe("calculateChangeRatio (via mergeModifiedLines)", () => {
  function makeDelete(lineNumber: number, content: string): Change {
    return { type: "delete", lineNumber, content } as Change;
  }
  function makeInsert(lineNumber: number, content: string): Change {
    return { type: "insert", lineNumber, content } as Change;
  }

  test("identical strings have ratio 0 (always merge)", () => {
    const changes = [makeDelete(1, "identical"), makeInsert(1, "identical")];
    const result = mergeModifiedLines(changes, { ...defaultOpts, maxChangeRatio: 0 });
    // ratio 0 means identical → merges
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("normal");
  });

  test("completely different strings have ratio 1 (never merge at tight threshold)", () => {
    const changes = [makeDelete(1, "aaaaaa"), makeInsert(1, "bbbbbb")];
    const result = mergeModifiedLines(changes, { ...defaultOpts, maxChangeRatio: 0.01 });
    // ratio ~1 → won't merge
    expect(result).toHaveLength(2);
  });
});

// ============================================================================
// diffCharsIfWithinEditLimit (tested via parseDiff inline diff behavior)
// ============================================================================

describe("diffCharsIfWithinEditLimit (via parseDiff inline diff)", () => {
  test(`char-level diff applied when edits ≤ INLINE_MAX_CHAR_EDITS (${INLINE_MAX_CHAR_EDITS})`, () => {
    // "baz" → "bar": diffChars edits = 1 removed ("z") + 1 added ("r") = 2 ≤ 4
    // Lines share enough common words (foo bar) for ratio ≤ 0.45
    const diff = makeDiff(`@@ -1,1 +1,1 @@
-foo bar baz
+foo bar bar`);
    const files = parseDiff(diff, { mergeModifiedLines: true, inlineMaxCharEdits: INLINE_MAX_CHAR_EDITS });
    const hunk = files[0].hunks.find((h) => h.type === "hunk");
    if (hunk?.type === "hunk") {
      const merged = hunk.lines[0];
      // Should be merged into a normal line with char-level inline diff
      expect(merged.type).toBe("normal");
      // Char-level segments: common prefix "ba", deleted "z", inserted "r"
      const deleteSegs = merged.content.filter((s) => s.type === "delete");
      const insertSegs = merged.content.filter((s) => s.type === "insert");
      expect(deleteSegs.length).toBeGreaterThan(0);
      expect(insertSegs.length).toBeGreaterThan(0);
    }
  });

  test("char-level diff NOT applied when edits exceed limit", () => {
    const longOld = "x".repeat(INLINE_MAX_CHAR_EDITS + 5);
    const longNew = "y".repeat(INLINE_MAX_CHAR_EDITS + 5);
    const diff = makeDiff(`@@ -1,1 +1,1 @@
-${longOld}
+${longNew}`);
    const files = parseDiff(diff, { mergeModifiedLines: true, inlineMaxCharEdits: INLINE_MAX_CHAR_EDITS });
    const hunk = files[0].hunks.find((h) => h.type === "hunk");
    if (hunk?.type === "hunk") {
      const line = hunk.lines[0];
      if (line.type === "normal") {
            // Each segment value should be at least INLINE_MAX_CHAR_EDITS+5 chars long
        const bigSeg = line.content.find((s) => s.value.length >= INLINE_MAX_CHAR_EDITS + 5);
        expect(bigSeg).toBeDefined();
      }
    }
  });
});

// ============================================================================
// parseDiff (top-level integration)
// ============================================================================

describe("parseDiff", () => {
  test("returns empty array for empty diff string", () => {
    expect(parseDiff("")).toHaveLength(0);
  });

  test("processes multiple files in one diff", () => {
    const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,1 +1,1 @@
-old
+new
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1,1 +1,1 @@
-x
+y`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
  });

  test("partial options override defaults", () => {
    const diff = makeDiff(`@@ -1,2 +1,2 @@
-foo
+foo bar`);
    // Should not throw with partial options
    const files = parseDiff(diff, { mergeModifiedLines: false });
    expect(files).toHaveLength(1);
  });

  test("inlineMaxCharEdits default matches INLINE_MAX_CHAR_EDITS constant", () => {
    // Parsing with default opts and with explicit INLINE_MAX_CHAR_EDITS should produce same result
    const diff = makeDiff(`@@ -1,1 +1,1 @@
-fooX
+fooy`);
    const withDefault = parseDiff(diff);
    const withExplicit = parseDiff(diff, { inlineMaxCharEdits: INLINE_MAX_CHAR_EDITS });
    // Structural equality (content values should match)
    const defaultHunk = withDefault[0].hunks[0];
    const explicitHunk = withExplicit[0].hunks[0];
    expect(defaultHunk).toEqual(explicitHunk);
  });
});
