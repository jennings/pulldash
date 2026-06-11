import { test, expect, describe } from "bun:test";
import { parseDiffWithHighlighting, highlightFileLines } from "./diff";

const SIMPLE_PATCH = `@@ -1,3 +1,3 @@
 context
-old line
+new line
 context`;

describe("parseDiffWithHighlighting", () => {
  test("returns empty hunks for empty patch", () => {
    const result = parseDiffWithHighlighting("", "test.ts");
    expect(result.hunks).toHaveLength(0);
  });

  test("parses a basic patch into hunks", () => {
    const result = parseDiffWithHighlighting(SIMPLE_PATCH, "test.ts");
    expect(result.hunks.length).toBeGreaterThan(0);
    expect(result.hunks[0].type).toBe("hunk");
  });

  test("returns cached result on second call with same cacheKey", () => {
    const key = "cache-test-unique-key-1";
    const r1 = parseDiffWithHighlighting(
      SIMPLE_PATCH,
      "test.ts",
      undefined,
      key
    );
    const r2 = parseDiffWithHighlighting(
      SIMPLE_PATCH,
      "test.ts",
      undefined,
      key
    );
    expect(r1).toBe(r2);
  });

  test("produces distinct objects for different cache keys", () => {
    const r1 = parseDiffWithHighlighting(
      SIMPLE_PATCH,
      "test.ts",
      undefined,
      "key-alpha"
    );
    const r2 = parseDiffWithHighlighting(
      SIMPLE_PATCH,
      "test.ts",
      undefined,
      "key-beta"
    );
    expect(r1).not.toBe(r2);
  });

  test("handles file rename (previousFilename)", () => {
    const result = parseDiffWithHighlighting(SIMPLE_PATCH, "new.ts", "old.js");
    expect(result.hunks.length).toBeGreaterThan(0);
  });

  test("uses syntax highlighting html on delete and insert lines", () => {
    const result = parseDiffWithHighlighting(SIMPLE_PATCH, "test.ts");
    const hunk = result.hunks.find((h) => h.type === "hunk");
    expect(hunk?.type).toBe("hunk");
    if (hunk?.type === "hunk") {
      const lines = hunk.lines;
      expect(
        lines.every((l) => l.content.every((s) => typeof s.html === "string"))
      ).toBe(true);
    }
  });

  test("mergeModifiedLines: adjacent delete+insert within ratio become one normal line", () => {
    const patch = `@@ -1,2 +1,2 @@
-foo bar
+foo baz`;
    const result = parseDiffWithHighlighting(patch, "test.ts");
    const hunk = result.hunks.find((h) => h.type === "hunk");
    expect(hunk?.type).toBe("hunk");
    if (hunk?.type === "hunk") {
      const merged = hunk.lines.find(
        (l) =>
          l.type === "normal" &&
          l.oldLineNumber !== undefined &&
          l.newLineNumber !== undefined
      );
      expect(merged).toBeDefined();
    }
  });

  test("inlineMaxCharEdits: lines too dissimilar to merge produce separate delete/insert", () => {
    // 50-char rewrite: calculateChangeRatio = 1.0 > maxChangeRatio 0.45 → no merge
    const longOld = "a".repeat(50);
    const longNew = "b".repeat(50);
    const patch = `@@ -1,1 +1,1 @@
-${longOld}
+${longNew}`;
    const result = parseDiffWithHighlighting(patch, "test.ts");
    const hunk = result.hunks.find((h) => h.type === "hunk");
    expect(hunk?.type).toBe("hunk");
    if (hunk?.type === "hunk") {
      // Lines that exceed the change ratio come out as separate delete/insert lines
      const lineTypes = hunk.lines.map((l) => l.type);
      expect(lineTypes).toContain("delete");
      expect(lineTypes).toContain("insert");
    }
  });

  test("inlineMaxCharEdits: word-level segments used when char diff exceeds limit", () => {
    // "baz" → "ZZZZZZ": char edits = 3+6 = 9 > INLINE_MAX_CHAR_EDITS(4), word-level segments used
    const patch = `@@ -1,1 +1,1 @@
-foo bar baz qux
+foo bar ZZZZZZ qux`;
    const result = parseDiffWithHighlighting(patch, "test.ts");
    const hunk = result.hunks.find((h) => h.type === "hunk");
    expect(hunk?.type).toBe("hunk");
    if (hunk?.type === "hunk") {
      const line = hunk.lines[0];
      expect(line.type).toBe("normal");
      // Word-level inline diff: delete whole "baz" word, insert whole "ZZZZZZ" word
      const types = line.content.map((s) => s.type);
      expect(types).toContain("delete");
      expect(types).toContain("insert");
    }
  });

  test("uses pre-highlighted file content when oldContent is provided", () => {
    const oldContent = "context\nold line\ncontext";
    const newContent = "context\nnew line\ncontext";
    const result = parseDiffWithHighlighting(
      SIMPLE_PATCH,
      "test.ts",
      undefined,
      undefined,
      oldContent,
      newContent
    );
    expect(result.hunks.length).toBeGreaterThan(0);
  });

  test("inserts skip block between non-adjacent hunks", () => {
    const patch = `@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,3 @@
 x
-y
+Y
 z`;
    const result = parseDiffWithHighlighting(patch, "test.ts");
    const skip = result.hunks.find((h) => h.type === "skip");
    expect(skip).toBeDefined();
    expect(skip?.type).toBe("skip");
  });
});

describe("highlightFileLines", () => {
  const content = "line 1\nline 2\nline 3\nline 4\nline 5";

  test("returns the requested number of lines", () => {
    const result = highlightFileLines(content, "test.ts", 1, 3);
    expect(result).toHaveLength(3);
  });

  test("all returned lines have type=normal", () => {
    const result = highlightFileLines(content, "test.ts", 1, 5);
    expect(result.every((l) => l.type === "normal")).toBe(true);
  });

  test("line numbers match the requested range", () => {
    const result = highlightFileLines(content, "test.ts", 2, 3);
    expect(result[0].oldLineNumber).toBe(2);
    expect(result[0].newLineNumber).toBe(2);
    expect(result[1].oldLineNumber).toBe(3);
    expect(result[2].oldLineNumber).toBe(4);
  });

  test("each line has a single content segment with html", () => {
    const result = highlightFileLines("const x = 1;", "test.ts", 1, 1);
    expect(result[0].content).toHaveLength(1);
    expect(typeof result[0].content[0].html).toBe("string");
  });

  test("handles startLine beyond file length gracefully", () => {
    const result = highlightFileLines(content, "test.ts", 20, 2);
    expect(result).toHaveLength(2);
    result.forEach((line) => {
      expect(line.content[0].value).toBe("");
    });
  });

  test("guesses language from extension for syntax highlighting", () => {
    const jsContent = "function foo() { return 1; }";
    const result = highlightFileLines(jsContent, "script.js", 1, 1);
    // With JS syntax highlighting, html will contain span tags
    expect(result[0].content[0].html).toContain("function");
  });
});
