import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { DiffWorkerPool, clearDiffCache } from "./diff";

// ============================================================================
// Fake Worker
// ============================================================================

type MessageHandler = (e: { data: any }) => void;
type ErrorHandler = (e: any) => void;

class FakeWorker {
  onmessage: MessageHandler | null = null;
  onerror: ErrorHandler | null = null;
  readonly messages: any[] = [];

  static instances: FakeWorker[] = [];

  constructor(_url: string, _opts?: object) {
    FakeWorker.instances.push(this);
  }

  postMessage(data: any) {
    this.messages.push(data);
    // By default, echo back a successful parse-diff-result on next microtask
    queueMicrotask(() => {
      if (this.onmessage && data?.type === "parse-diff") {
        this.onmessage({
          data: { type: "parse-diff-result", id: data.id, result: { hunks: [] } },
        });
      } else if (this.onmessage && data?.type === "highlight-lines") {
        this.onmessage({
          data: { type: "highlight-lines-result", id: data.id, result: [] },
        });
      } else if (this.onmessage && data?.type === "interdiff") {
        this.onmessage({
          data: { type: "interdiff-result", id: data.id, result: { hunks: [] } },
        });
      }
    });
  }

  terminate() {
    FakeWorker.instances = FakeWorker.instances.filter((w) => w !== this);
  }

  // Test helper: simulate an error response
  replyError(id: string, error: string) {
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: "error", id, error } });
    });
  }
}

const originalWorker = (globalThis as any).Worker;

beforeEach(() => {
  FakeWorker.instances = [];
  (globalThis as any).Worker = FakeWorker;
  clearDiffCache();
});

afterEach(() => {
  (globalThis as any).Worker = originalWorker;
});

// ============================================================================
// Pool initialization
// ============================================================================

describe("pool initialization", () => {
  test("workers are not created until first method call (lazy init)", () => {
    new DiffWorkerPool();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  test("workers are created on first use", async () => {
    const pool = new DiffWorkerPool();
    await pool.parseDiff("", "test.ts");
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
  });

  test("second call does not create additional workers (already initialized)", async () => {
    const pool = new DiffWorkerPool();
    await pool.parseDiff("", "test.ts");
    const countAfterFirst = FakeWorker.instances.length;
    await pool.parseDiff("", "test.ts");
    expect(FakeWorker.instances.length).toBe(countAfterFirst);
  });

  test("terminate clears all workers", async () => {
    const pool = new DiffWorkerPool();
    await pool.parseDiff("", "test.ts");
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
    pool.terminate();
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

// ============================================================================
// Request dispatch
// ============================================================================

describe("request dispatch", () => {
  test("parseDiff sends parse-diff message to a worker", async () => {
    const pool = new DiffWorkerPool();
    await pool.parseDiff("", "test.ts");
    const allMessages = FakeWorker.instances.flatMap((w) => w.messages);
    const msg = allMessages.find((m) => m.type === "parse-diff");
    expect(msg).toBeDefined();
    expect(msg.filename).toBe("test.ts");
  });

  test("highlightLines sends highlight-lines message to a worker", async () => {
    const pool = new DiffWorkerPool();
    await pool.highlightLines("content", "test.ts", 1, 5);
    const allMessages = FakeWorker.instances.flatMap((w) => w.messages);
    const msg = allMessages.find((m) => m.type === "highlight-lines");
    expect(msg).toBeDefined();
    expect(msg.startLine).toBe(1);
    expect(msg.count).toBe(5);
  });

  test("interdiff sends interdiff message to a worker", async () => {
    const pool = new DiffWorkerPool();
    await pool.interdiff("patch1", "patch2");
    const allMessages = FakeWorker.instances.flatMap((w) => w.messages);
    const msg = allMessages.find((m) => m.type === "interdiff");
    expect(msg).toBeDefined();
    expect(msg.patch1).toBe("patch1");
    expect(msg.patch2).toBe("patch2");
  });

  test("parseDiffBatch dispatches one message per item", async () => {
    const pool = new DiffWorkerPool();
    await pool.parseDiffBatch([
      { patch: "", filename: "a.ts" },
      { patch: "", filename: "b.ts" },
    ]);
    const allMessages = FakeWorker.instances.flatMap((w) => w.messages);
    const msgs = allMessages.filter((m) => m.type === "parse-diff");
    expect(msgs).toHaveLength(2);
    const filenames = msgs.map((m) => m.filename);
    expect(filenames).toContain("a.ts");
    expect(filenames).toContain("b.ts");
  });

  test("concurrent requests get unique IDs", async () => {
    const pool = new DiffWorkerPool();
    await Promise.all([
      pool.parseDiff("", "a.ts"),
      pool.parseDiff("", "b.ts"),
      pool.parseDiff("", "c.ts"),
    ]);
    const allMessages = FakeWorker.instances.flatMap((w) => w.messages);
    const ids = allMessages.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ============================================================================
// Error propagation
// ============================================================================

describe("error propagation", () => {
  test("parseDiff rejects when worker posts error response", async () => {
    class ErrorWorker extends FakeWorker {
      postMessage(data: any) {
        this.messages.push(data);
        queueMicrotask(() => {
          this.onmessage?.({ data: { type: "error", id: data.id, error: "parse failed" } });
        });
      }
    }
    (globalThis as any).Worker = ErrorWorker;

    const pool = new DiffWorkerPool();
    await expect(pool.parseDiff("", "test.ts")).rejects.toThrow("parse failed");
  });
});
