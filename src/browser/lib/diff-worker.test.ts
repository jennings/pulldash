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
        count: 3,
      },
    });

    const lines = posted[0].result;
    expect(lines.every((l: any) => l.type === "normal")).toBe(true);
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
});
