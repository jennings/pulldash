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
    expect(posted[0].result).toBe("");
  });

  test("posts an error response with the request id when interdiff throws", () => {
    handler({
      data: { type: "interdiff", id: "boom", patch1: null, patch2: "x" },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("error");
    expect(posted[0].id).toBe("boom");
    expect(typeof posted[0].error).toBe("string");
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

    expect(posted[0].result).toContain("@@");
    expect(posted[0].result).toContain("-v1");
    expect(posted[0].result).toContain("+v2");
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
});
