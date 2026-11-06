/**
 * Diff Service - Async API wrapper for the interdiff WebWorker.
 *
 * Interdiff of large patches is CPU-heavy (hundreds of ms for ~10k-line files),
 * so it runs off the main thread. Parsing and highlighting live in
 * `@pierre/diffs` (see `file-diff.ts` and `pierre.tsx`).
 *
 * Usage:
 *   import { diffService } from './diff';
 *   const patch = await diffService.interdiff(patch1, patch2);
 */

import type { WorkerRequest, WorkerResponse } from "./diff-worker";

// ============================================================================
// Worker Pool
// ============================================================================

const POOL_SIZE = Math.max(
  1,
  Math.min(4, (navigator.hardwareConcurrency || 2) - 1)
);

interface PendingRequest {
  worker: Worker;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export class DiffWorkerPool {
  private workers: Worker[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private nextId = 0;
  private nextWorkerIndex = 0;
  private loads = new Map<Worker, number>();

  private createWorker() {
    const worker = new Worker(
      typeof __DIFF_WORKER_URL__ === "undefined"
        ? "/lib/diff-worker.js"
        : __DIFF_WORKER_URL__,
      {
        type: "module",
      }
    );

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pendingRequests.get(response.id);
      if (!pending) return;

      this.pendingRequests.delete(response.id);
      this.loads.set(worker, (this.loads.get(worker) ?? 1) - 1);

      if (response.type === "error") {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response.result);
      }
    };

    worker.onerror = (error) => {
      this.failWorker(worker, new Error(error.message || "Diff worker failed"));
    };
    worker.onmessageerror = () =>
      this.failWorker(worker, new Error("Invalid diff worker response"));

    this.workers.push(worker);
    this.loads.set(worker, 0);
    return worker;
  }

  private failWorker(worker: Worker, error: Error) {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.worker !== worker) continue;
      this.pendingRequests.delete(id);
      pending.reject(error);
    }
    worker.terminate();
    this.workers = this.workers.filter((candidate) => candidate !== worker);
    this.loads.delete(worker);
  }

  private getNextWorker(): Worker {
    const idle = this.workers.find((worker) => this.loads.get(worker) === 0);
    if (idle) return idle;
    if (this.workers.length < POOL_SIZE) return this.createWorker();
    const worker = this.workers[this.nextWorkerIndex % this.workers.length];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
    return worker;
  }

  private generateId(): string {
    return `${Date.now()}-${this.nextId++}`;
  }

  /** Hunk-only unified patch of the deliberate changes between two patches. */
  async interdiff(patch1: string, patch2: string): Promise<string> {
    const id = this.generateId();
    const worker = this.getNextWorker();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { worker, resolve, reject });
      this.loads.set(worker, (this.loads.get(worker) ?? 0) + 1);

      worker.postMessage({
        type: "interdiff",
        id,
        patch1,
        patch2,
      } satisfies WorkerRequest);
    });
  }

  /**
   * Terminate all workers (call on app unmount if needed).
   */
  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("Diff worker pool terminated"));
    }
    this.pendingRequests.clear();
    this.loads.clear();
    this.nextWorkerIndex = 0;
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const diffService = new DiffWorkerPool();
