import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  observeMergedState,
  NotificationBatch,
  markSelfActivity,
  consumeSelfActivity,
  getNotifiedAt,
} from "./notifications";

// Minimal in-memory localStorage stub (Bun has no localStorage)
const store = new Map<string, string>();
const reads = new Map<string, number>();
const writes = new Map<string, number>();
const storage = {
  getItem: (k: string) => {
    reads.set(k, (reads.get(k) ?? 0) + 1);
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    writes.set(k, (writes.get(k) ?? 0) + 1);
    store.set(k, v);
  },
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
} as unknown as Storage;
let previousStorage: Storage;

beforeEach(() => {
  previousStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  store.clear();
  reads.clear();
  writes.clear();
});
afterEach(() => {
  globalThis.localStorage = previousStorage;
});

test("observeMergedState: first observation is never a transition", () => {
  expect(observeMergedState("o/r#1", false)).toBe(false);
  expect(observeMergedState("o/r#2", true)).toBe(false);
});

test("observeMergedState: unmerged→merged transitions exactly once", () => {
  expect(observeMergedState("o/r#1", false)).toBe(false);
  expect(observeMergedState("o/r#1", true)).toBe(true);
  // Repeated observations of the merged state stay silent
  expect(observeMergedState("o/r#1", true)).toBe(false);
});

test("observeMergedState: reopen after merge only updates the baseline", () => {
  expect(observeMergedState("o/r#1", false)).toBe(false);
  expect(observeMergedState("o/r#1", true)).toBe(true);
  expect(observeMergedState("o/r#1", false)).toBe(false);
  // And a second merge after the reopen notifies again
  expect(observeMergedState("o/r#1", true)).toBe(true);
});

test("a notification pass reads each map once and flushes changes once", () => {
  markSelfActivity("o/r#1");
  reads.clear();
  writes.clear();
  const batch = new NotificationBatch();
  for (const id of ["o/r#1", "o/r#2"]) {
    expect(batch.getNotifiedAt(id)).toBeNull();
    batch.setNotifiedAt(id, "2026-10-16T12:00:00Z");
    expect(batch.consumeSelfActivity(id)).toBe(id === "o/r#1");
    expect(batch.consumeSelfActivity(id)).toBe(false);
    expect(batch.observeMergedState(id, false)).toBe(false);
  }
  expect([...reads.values()]).toEqual([1, 1, 1]);
  expect(writes.size).toBe(0);
  batch.flush();
  expect([...writes.values()]).toEqual([1, 1, 1]);
  batch.flush();
  expect([...writes.values()]).toEqual([1, 1, 1]);
  expect(getNotifiedAt("o/r#2")).toBe("2026-10-16T12:00:00Z");
  expect(consumeSelfActivity("o/r#1")).toBe(false);

  writes.clear();
  const unchanged = new NotificationBatch();
  unchanged.setNotifiedAt("o/r#2", "2026-10-16T12:00:00Z");
  unchanged.observeMergedState("o/r#2", false);
  unchanged.flush();
  expect(writes.size).toBe(0);

  // A new pass reads changes made by another window rather than reusing a cache.
  store.set(
    "pulldash_merged_seen",
    JSON.stringify({ "o/r#2": { m: 0, t: Date.now() } })
  );
  expect(observeMergedState("o/r#2", true)).toBe(true);
});

test("batched notifications prune old timestamps and recover from corrupt records", () => {
  store.set(
    "pulldash_notified_timestamps",
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 1001 }, (_, id) => [
          String(id),
          "2000-01-01T00:00:00Z",
        ])
      )
    )
  );
  store.set("pulldash_merged_seen", "null");
  store.set("pulldash_self_activity", "not JSON");
  const batch = new NotificationBatch();
  batch.setNotifiedAt("current", new Date().toISOString());
  expect(batch.observeMergedState("current", false)).toBe(false);
  expect(batch.consumeSelfActivity("current")).toBe(false);
  batch.flush();
  expect(
    Object.keys(JSON.parse(store.get("pulldash_notified_timestamps")!))
  ).toEqual(["current"]);
  expect(writes.get("pulldash_notified_timestamps")).toBe(1);
});
