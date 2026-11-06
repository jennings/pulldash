import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { DiffWorkerPool } from "./diff";

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
    // By default, echo back a successful interdiff-result on next microtask
    queueMicrotask(() => {
      if (this.onmessage && data?.type === "interdiff") {
        this.onmessage({
          data: {
            type: "interdiff-result",
            id: data.id,
            result: "",
          },
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
    await pool.interdiff("", "");
    expect(FakeWorker.instances).toHaveLength(1);
  });

  test("concurrent work grows the pool only up to the core-aware cap", async () => {
    const pool = new DiffWorkerPool();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => pool.interdiff("", `${i}`))
    );
    expect(FakeWorker.instances).toHaveLength(
      Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
    );
    expect(
      FakeWorker.instances.flatMap((worker) => worker.messages)
    ).toHaveLength(12);
    pool.terminate();
  });

  test("second call does not create additional workers (already initialized)", async () => {
    const pool = new DiffWorkerPool();
    await pool.interdiff("", "");
    const countAfterFirst = FakeWorker.instances.length;
    await pool.interdiff("", "");
    expect(FakeWorker.instances.length).toBe(countAfterFirst);
  });

  test("terminate clears all workers", async () => {
    const pool = new DiffWorkerPool();
    await pool.interdiff("", "");
    expect(FakeWorker.instances.length).toBeGreaterThan(0);
    pool.terminate();
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

// ============================================================================
// Request dispatch
// ============================================================================

describe("request dispatch", () => {
  test("interdiff sends interdiff message to a worker", async () => {
    const pool = new DiffWorkerPool();
    await pool.interdiff("patch1", "patch2");
    const allMessages = FakeWorker.instances.flatMap((w) => w.messages);
    const msg = allMessages.find((m) => m.type === "interdiff");
    expect(msg).toBeDefined();
    expect(msg.patch1).toBe("patch1");
    expect(msg.patch2).toBe("patch2");
  });

  test("concurrent requests get unique IDs", async () => {
    const pool = new DiffWorkerPool();
    await Promise.all([
      pool.interdiff("", "a"),
      pool.interdiff("", "b"),
      pool.interdiff("", "c"),
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
  test("native worker failure rejects its request and retires the worker", async () => {
    class PendingWorker extends FakeWorker {
      postMessage(data: any) {
        this.messages.push(data);
      }
    }
    (globalThis as any).Worker = PendingWorker;
    const pool = new DiffWorkerPool();
    const request = pool.interdiff("", "");
    const failed = FakeWorker.instances.find(
      (worker) => worker.messages.length
    )!;
    failed.onerror?.({ message: "worker crashed" });
    await expect(request).rejects.toThrow("worker crashed");
    expect(FakeWorker.instances).not.toContain(failed);
    pool.terminate();
  });

  test("terminate rejects all outstanding work and allows reuse", async () => {
    class PendingWorker extends FakeWorker {
      postMessage(data: any) {
        this.messages.push(data);
      }
    }
    (globalThis as any).Worker = PendingWorker;
    const pool = new DiffWorkerPool();
    const requests = [pool.interdiff("", "a"), pool.interdiff("", "b")];
    const settled = Promise.allSettled(requests);
    pool.terminate();
    for (const result of await settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.message).toContain("terminated");
    }
    (globalThis as any).Worker = FakeWorker;
    expect(await pool.interdiff("", "c")).toBe("");
    pool.terminate();
  });

  test("interdiff rejects when worker posts error response", async () => {
    class ErrorWorker extends FakeWorker {
      postMessage(data: any) {
        this.messages.push(data);
        queueMicrotask(() => {
          this.onmessage?.({
            data: { type: "error", id: data.id, error: "parse failed" },
          });
        });
      }
    }
    (globalThis as any).Worker = ErrorWorker;

    const pool = new DiffWorkerPool();
    await expect(pool.interdiff("", "")).rejects.toThrow("parse failed");
  });
});
