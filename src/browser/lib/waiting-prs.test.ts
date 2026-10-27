import { test, expect, beforeEach } from "bun:test";
import {
  getLastViewed,
  setLastViewed,
  clearLastViewed,
  getLastViewedVersion,
  subscribeLastViewed,
} from "./waiting-prs";
import {
  initializeTimelineReadState,
  markTimelineCommentsRead,
  saveTimelineReadState,
} from "./timeline-read";

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

test("setLastViewed round-trips and clearLastViewed removes", () => {
  expect(getLastViewed("o/r#1")).toBeNull();
  setLastViewed("o/r#1");
  expect(getLastViewed("o/r#1")).not.toBeNull();
  clearLastViewed("o/r#1");
  expect(getLastViewed("o/r#1")).toBeNull();
});

test("version bumps and listeners fire on set/clear", () => {
  let events = 0;
  const unsubscribe = subscribeLastViewed(() => events++);
  const v0 = getLastViewedVersion();
  setLastViewed("o/r#2");
  expect(events).toBe(1);
  expect(getLastViewedVersion()).toBeGreaterThan(v0);
  clearLastViewed("o/r#2");
  expect(events).toBe(2);
  unsubscribe();
  setLastViewed("o/r#3");
  expect(events).toBe(2);
});

test("opening a PR preserves its previous timeline baseline and per-comment read state", () => {
  const previous = "2026-01-01T00:00:00Z";
  store.set("pulldash_viewed_prs", JSON.stringify({ "o/r#1": previous }));
  setLastViewed("o/r#1");
  const initial = initializeTimelineReadState("o/r#1", null);
  expect(initial).toEqual({ baseline: previous, seen: {} });
  const read = markTimelineCommentsRead(initial, [
    {
      id: "discussion_r1",
      updatedAt: "2026-01-02T00:00:00Z",
      author: "reviewer",
    },
  ]);
  saveTimelineReadState("o/r#1", read);
  setLastViewed("o/r#1");
  expect(initializeTimelineReadState("o/r#1", null)).toEqual(read);
});
