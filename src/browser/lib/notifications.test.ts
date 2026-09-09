import { test, expect, beforeEach } from "bun:test";
import { observeMergedState } from "./notifications";

// Minimal in-memory localStorage stub (Bun has no localStorage)
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
} as unknown as Storage;

beforeEach(() => {
  store.clear();
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
