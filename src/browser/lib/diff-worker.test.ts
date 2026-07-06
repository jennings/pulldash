import { test, expect, describe, beforeEach } from "bun:test";

// Must be set before the module loads, since diff-worker.ts calls `self.postMessage`
// inside the handler (not at load time), but we set it here for clarity.
const posted: any[] = [];
(globalThis as any).postMessage = (data: unknown) => {
  posted.push(data);
};

// Import the module: this sets globalThis.onmessage to the worker handler
import "./diff-worker";

const handler = (globalThis as any).onmessage as (e: { data: any }) => void;

beforeEach(() => {
  posted.length = 0;
});

// ============================================================================
// parse-diff dispatch
// ============================================================================

describe("parse-diff message", () => {
  test("dispatches parse-diff and posts parse-diff-result", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old
+new
 context`;

    handler({
      data: { type: "parse-diff", id: "1", patch, filename: "test.ts" },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("parse-diff-result");
    expect(posted[0].id).toBe("1");
    expect(posted[0].result).toBeDefined();
    expect(Array.isArray(posted[0].result.hunks)).toBe(true);
  });

  test("result contains hunk with lines for a non-empty patch", () => {
    const patch = `@@ -1,2 +1,2 @@
-foo
+bar`;

    handler({
      data: { type: "parse-diff", id: "2", patch, filename: "test.ts" },
    });

    const response = posted[0];
    expect(response.type).toBe("parse-diff-result");
    const hunk = response.result.hunks.find((h: any) => h.type === "hunk");
    expect(hunk).toBeDefined();
    expect(hunk.lines.length).toBeGreaterThan(0);
  });

  test("result is empty hunks for an empty/invalid patch", () => {
    handler({
      data: { type: "parse-diff", id: "3", patch: "", filename: "test.ts" },
    });

    expect(posted[0].type).toBe("parse-diff-result");
    expect(posted[0].result.hunks).toHaveLength(0);
  });

  test("accepts optional previousFilename, oldContent, newContent", () => {
    const patch = `@@ -1,1 +1,1 @@
-old
+new`;

    handler({
      data: {
        type: "parse-diff",
        id: "4",
        patch,
        filename: "new.ts",
        previousFilename: "old.js",
        oldContent: "old\n",
        newContent: "new\n",
      },
    });

    expect(posted[0].type).toBe("parse-diff-result");
    expect(posted[0].result.hunks.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// highlight-lines dispatch
// ============================================================================

describe("highlight-lines message", () => {
  test("dispatches highlight-lines and posts highlight-lines-result", () => {
    handler({
      data: {
        type: "highlight-lines",
        id: "5",
        content: "const x = 1;\nconst y = 2;\nconst z = 3;",
        filename: "test.ts",
        startLine: 1,
        oldStartLine: 1,
        count: 2,
      },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("highlight-lines-result");
    expect(posted[0].id).toBe("5");
    expect(Array.isArray(posted[0].result)).toBe(true);
    expect(posted[0].result).toHaveLength(2);
  });

  test("all returned lines have type=normal", () => {
    handler({
      data: {
        type: "highlight-lines",
        id: "6",
        content: "line1\nline2\nline3",
        filename: "test.ts",
        startLine: 1,
        oldStartLine: 1,
        count: 3,
      },
    });

    const lines = posted[0].result;
    expect(lines.every((l: any) => l.type === "normal")).toBe(true);
  });

  test("old and new line numbers can differ (drift from hunks above)", () => {
    // Simulates expanding a skip block below a hunk that added 3 net lines:
    // the same visible content is at newLine=10 but oldLine=7 in the base file.
    handler({
      data: {
        type: "highlight-lines",
        id: "drift-1",
        content: Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join(
          "\n"
        ),
        filename: "test.ts",
        startLine: 10,
        oldStartLine: 7,
        count: 3,
      },
    });

    expect(posted[0].result).toHaveLength(3);
    expect(posted[0].result[0].newLineNumber).toBe(10);
    expect(posted[0].result[0].oldLineNumber).toBe(7);
    expect(posted[0].result[2].newLineNumber).toBe(12);
    expect(posted[0].result[2].oldLineNumber).toBe(9);
  });

  test("count clamps to end of file", () => {
    // Trailing-newline file with 3 real lines; asking for a huge count must
    // return exactly 3, not iterate past EOF with empty content.
    handler({
      data: {
        type: "highlight-lines",
        id: "clamp-1",
        content: "line1\nline2\nline3\n",
        filename: "test.ts",
        startLine: 1,
        oldStartLine: 1,
        count: Number.MAX_SAFE_INTEGER,
      },
    });

    expect(posted[0].result).toHaveLength(3);
    expect(posted[0].result[0].newLineNumber).toBe(1);
    expect(posted[0].result[2].newLineNumber).toBe(3);
  });

  test("count clamps when startLine is partway through the file", () => {
    handler({
      data: {
        type: "highlight-lines",
        id: "clamp-2",
        content: "a\nb\nc\nd\ne",
        filename: "test.ts",
        startLine: 4,
        oldStartLine: 4,
        count: 999,
      },
    });

    expect(posted[0].result).toHaveLength(2);
    expect(posted[0].result[0].newLineNumber).toBe(4);
    expect(posted[0].result[1].newLineNumber).toBe(5);
  });
});

// ============================================================================
// interdiff dispatch
// ============================================================================

describe("interdiff message", () => {
  test("dispatches interdiff and posts interdiff-result", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old
+new
 context`;

    handler({
      data: { type: "interdiff", id: "7", patch1: patch, patch2: patch },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("interdiff-result");
    expect(posted[0].id).toBe("7");
    expect(posted[0].result).toBeDefined();
    expect(Array.isArray(posted[0].result.hunks)).toBe(true);
  });

  test("identical patches produce empty interdiff", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old
+new
 context`;

    handler({
      data: { type: "interdiff", id: "8", patch1: patch, patch2: patch },
    });

    expect(posted[0].result.hunks).toHaveLength(0);
  });

  test("different patches produce non-empty interdiff", () => {
    const patch1 = `@@ -1,3 +1,3 @@
 context
-old
+v1
 context`;
    const patch2 = `@@ -1,3 +1,3 @@
 context
-old
+v2
 context`;

    handler({ data: { type: "interdiff", id: "9", patch1, patch2 } });

    expect(posted[0].result.hunks.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// error propagation
// ============================================================================

describe("error propagation", () => {
  test("unknown message type produces no response (switch falls through)", () => {
    handler({ data: { type: "unknown-type", id: "err-test" } } as any);
    expect(posted).toHaveLength(0);
  });

  test("parse-diff with a bad patch posts an error response rather than throwing", () => {
    // parseDiffWithHighlighting is resilient (returns {hunks: []}) for bad patches,
    // so the handler should always post a result, not an error, for well-formed messages
    handler({
      data: {
        type: "parse-diff",
        id: "bad",
        patch: "not a valid patch",
        filename: "x.ts",
      },
    });
    expect(posted).toHaveLength(1);
    // Either a result or an error — either way something is posted and the handler doesn't throw
    expect(["parse-diff-result", "error"]).toContain(posted[0].type);
  });

  test("merges delete+insert pair when offset between old/new line numbers exceeds maxDiffDistance", () => {
    // Hunk: @@ -780,3 +183,3 @@
    // Delete has oldLineNumber=781, Insert has newLineNumber=184
    // Difference of 597 is well above maxDiffDistance=30
    // The function should use change index, not absolute line numbers, to pair them
    const patch = [
      "@@ -780,3 +183,3 @@",
      " context",
      "-%package -n python2-perf",
      "+%package -n python3-perf",
      " context",
    ].join("\n");

    handler({
      data: {
        type: "parse-diff",
        id: "large-offset",
        patch,
        filename: "kernel.spec",
      },
    });

    const result = posted[0].result;
    const hunks = result.hunks;
    // First hunk is a skip block (lines 1-779), second is the actual hunk
    const hunk = hunks[1];
    expect(hunk).toBeDefined();
    expect(hunk.lines).toHaveLength(3);

    const [contextLine, modifiedLine, contextLine2] = hunk.lines;

    // First line: context
    expect(contextLine.type).toBe("normal");
    expect(contextLine.content[0].value).toBe("context");

    // Second line: should be a single merged "normal" line (not separate delete+insert)
    expect(modifiedLine.type).toBe("normal");
    expect(modifiedLine.oldLineNumber).toBe(781);
    expect(modifiedLine.newLineNumber).toBe(184);
    // Word-diff segments: at least one insert and one delete for the single-char change
    const hasInsert = modifiedLine.content.some(
      (s: any) => s.type === "insert"
    );
    const hasDelete = modifiedLine.content.some(
      (s: any) => s.type === "delete"
    );
    expect(hasInsert).toBe(true);
    expect(hasDelete).toBe(true);

    // Third line: context
    expect(contextLine2.type).toBe("normal");
    expect(contextLine2.content[0].value).toBe("context");
  });
  test("crossing content-based pairings unpair the worse match only", () => {
    const patch = [
      "@@ -767,4 +767,4 @@",
      "-apple banana cherry",
      "-xray yankee zulu",
      "+xray yankee alpha",
      "+apple banana delta",
    ].join("\n");

    handler({
      data: {
        type: "parse-diff",
        id: "crossed-pairings",
        patch,
        filename: "test.py",
      },
    });

    const result = posted[0].result;
    const hunks = result.hunks;
    const hunk = hunks.find((h: any) => h.type === "hunk");
    expect(hunk).toBeDefined();

    // Crossing has equal deltas (both =1), so first pair (D767→I768) is unpaired
    // Only the better match (D768→I767, delta=1) remains merged
    const mergedLines = hunk.lines.filter(
      (l: any) =>
        l.type === "normal" && l.content.some((s: any) => s.type !== "normal")
    );
    expect(mergedLines).toHaveLength(1);
    expect(mergedLines[0].oldLineNumber).toBe(768);
    expect(mergedLines[0].newLineNumber).toBe(767);

    // The unpaired delete (old 767) and unpaired insert (new 768) remain separate
    const deletes = hunk.lines.filter((l: any) => l.type === "delete");
    const inserts = hunk.lines.filter((l: any) => l.type === "insert");
    expect(deletes).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(deletes[0].oldLineNumber).toBe(767);
    expect(inserts[0].newLineNumber).toBe(768);
  });

  test("merges delete+insert pair when change only differs by digit inside underscore-separated word", () => {
    // Old: %{python2_sitearch}/*   New: %{python3_sitearch}/*
    // _ is treated as separator, so python2 and python3 are separate tokens
    const patch = [
      "@@ -1068,3 +463,3 @@",
      " context",
      "-%{python2_sitearch}/*",
      "+%{python3_sitearch}/*",
      " context",
    ].join("\n");

    handler({
      data: {
        type: "parse-diff",
        id: "sitearch",
        patch,
        filename: "kernel.spec",
      },
    });

    const result = posted[0].result;
    const hunks = result.hunks;
    // First hunk is a skip block, second is the actual hunk
    const hunk = hunks[1];
    expect(hunk).toBeDefined();
    expect(hunk.lines).toHaveLength(3);

    const [contextLine, modifiedLine, contextLine2] = hunk.lines;

    // First line: context
    expect(contextLine.type).toBe("normal");

    // Second line: should be a single merged "normal" line
    expect(modifiedLine.type).toBe("normal");
    expect(modifiedLine.oldLineNumber).toBe(1069);
    expect(modifiedLine.newLineNumber).toBe(464);
    // Word-diff segments: at least one insert and one delete
    const hasInsert = modifiedLine.content.some(
      (s: any) => s.type === "insert"
    );
    const hasDelete = modifiedLine.content.some(
      (s: any) => s.type === "delete"
    );
    expect(hasInsert).toBe(true);
    expect(hasDelete).toBe(true);

    // Third line: context
    expect(contextLine2.type).toBe("normal");
    expect(contextLine2.content[0].value).toBe("context");
  });
});
