import { expect, test } from "bun:test";
import type { OverviewTimelineEntry } from "./overview-timeline";
import {
  getTimelineComments,
  getUnreadTimelineComments,
  initializeTimelineReadState,
  markTimelineCommentsRead,
  nextUnreadTimelineComment,
  observeUnreadTimelineComments,
  saveTimelineReadState,
  type TimelineComment,
  type TimelineReadState,
} from "./timeline-read";

const date = (day: number) =>
  `2026-01-${String(day).padStart(2, "0")}T12:00:00Z`;
const comment = (
  id: string,
  day = 2,
  author: string | null = "reviewer"
): TimelineComment => ({ id, updatedAt: date(day), author });

test("timeline read targets follow rendered order, including late replies in old and resolved threads", () => {
  const thread = {
    id: "old-thread",
    isResolved: true,
    comments: {
      nodes: [
        {
          databaseId: 1,
          createdAt: date(1),
          updatedAt: date(1),
          author: { login: "reviewer" },
        },
        {
          databaseId: 2,
          createdAt: date(5),
          updatedAt: date(5),
          author: { login: "reviewer" },
        },
      ],
    },
  };
  const entries = [
    {
      type: "review",
      data: {
        id: 3,
        body: "Summary",
        submitted_at: date(1),
        user: { login: "reviewer" },
      },
      threads: [thread],
    },
    {
      type: "comment",
      data: {
        id: 4,
        created_at: date(3),
        updated_at: date(4),
        user: { login: "author" },
      },
    },
    {
      type: "review",
      data: { id: 5, body: "  ", user: { login: "reviewer" } },
      threads: [],
    },
    { type: "comment", data: { id: 6, created_at: date(3), user: null } },
    { type: "thread", data: thread },
  ] as unknown as OverviewTimelineEntry[];
  const comments = getTimelineComments(entries);
  expect(comments.map((c) => c.id)).toEqual([
    "pullrequestreview-3",
    "discussion_r1",
    "discussion_r2",
    "issuecomment-4",
  ]);
  expect(comments[2]).toEqual({
    id: "discussion_r2",
    threadId: "reviewthread-old-thread",
    reply: true,
    updatedAt: date(5),
    author: "reviewer",
  });
  expect(comments[3]!.updatedAt).toBe(date(4));
});

test("reading one comment leaves unseen replies unread across visits and edits become unread again", () => {
  const comments = [
    comment("old", 1),
    comment("reached"),
    comment("unseen", 3),
    comment("own", 3, "Me"),
    comment("deleted-author", 3, null),
  ];
  const state: TimelineReadState = { baseline: date(1), seen: {} };
  expect(
    getUnreadTimelineComments(comments, state, "me").map((c) => c.id)
  ).toEqual(["reached", "unseen", "deleted-author"]);
  const next = markTimelineCommentsRead(state, [comments[1]!]);
  expect(
    getUnreadTimelineComments(comments, next, "me").map((c) => c.id)
  ).toEqual(["unseen", "deleted-author"]);
  expect(markTimelineCommentsRead(next, [comments[1]!])).toBe(next);
  expect(
    getUnreadTimelineComments([comment("reached", 4)], next, "me")
  ).toHaveLength(1);
  const allRead = markTimelineCommentsRead(next, comments);
  expect(getUnreadTimelineComments(comments, allRead, "me")).toEqual([]);
  expect(
    getUnreadTimelineComments(
      [...comments, comment("arrived-later", 2)],
      allRead,
      "me"
    ).map((c) => c.id)
  ).toEqual(["arrived-later"]);
});

test("timeline read state persists separately from the PR-wide viewed timestamp", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const initial = initializeTimelineReadState("o/r#1", date(1), storage);
  const state = markTimelineCommentsRead(initial, [comment("read")]);
  saveTimelineReadState("o/r#1", state, storage);
  expect(initializeTimelineReadState("o/r#1", date(10), storage)).toEqual(
    state
  );
  expect(initializeTimelineReadState("o/r#2", null, storage)).toEqual({
    baseline: null,
    seen: {},
  });
  for (const key of values.keys()) values.set(key, "corrupt");
  expect(initializeTimelineReadState("o/r#1", date(1), storage)).toEqual(
    initial
  );
  expect(() =>
    saveTimelineReadState("o/r#1", state, {
      setItem: () => {
        throw new Error("Storage full");
      },
    })
  ).not.toThrow();
});

test("next unread visits individual comments in timeline order, skips read comments, and wraps", () => {
  const comments = [
    comment("late-reply-high-up", 5),
    comment("read"),
    comment("later-card", 3),
  ];
  const unread = new Set(["late-reply-high-up", "later-card"]);
  expect(nextUnreadTimelineComment(comments, unread, null)?.id).toBe(
    "late-reply-high-up"
  );
  expect(
    nextUnreadTimelineComment(comments, unread, "late-reply-high-up")?.id
  ).toBe("later-card");
  expect(nextUnreadTimelineComment(comments, unread, "later-card")?.id).toBe(
    "late-reply-high-up"
  );
  expect(nextUnreadTimelineComment(comments, new Set(), null)).toBeUndefined();
});

test("only visible comment markers are read, including replies mounted after a resolved thread expands", () => {
  const originalIntersection = globalThis.IntersectionObserver;
  const originalMutation = globalThis.MutationObserver;
  let intersect: (entries: IntersectionObserverEntry[]) => void = () => {};
  let mutate = () => {};
  let mutationDisconnected = false;
  const observed = new Set<Element>();
  const options: IntersectionObserverInit[] = [];
  class FakeIntersection {
    constructor(callback: typeof intersect, init: IntersectionObserverInit) {
      intersect = callback;
      options.push(init);
    }
    observe(element: Element) {
      observed.add(element);
    }
    unobserve(element: Element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  }
  class FakeMutation {
    constructor(callback: () => void) {
      mutate = callback;
    }
    observe() {}
    disconnect() {
      mutationDisconnected = true;
    }
  }
  globalThis.IntersectionObserver = FakeIntersection as never;
  globalThis.MutationObserver = FakeMutation as never;
  const events = new Map<string, () => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (event: string, fn: () => void) => events.set(event, fn),
    removeEventListener: (event: string) => events.delete(event),
  };
  const marker = (id: string) =>
    ({ getAttribute: () => id }) as unknown as Element;
  const first = marker("first");
  const reply = marker("reply");
  const elements = [first];
  const root = {
    ownerDocument: doc,
    querySelectorAll: () => elements,
  } as unknown as HTMLElement;
  const comments = [comment("first"), comment("reply")];
  const unread = new Set(comments.map((c) => c.id));
  const reached: string[] = [];
  const emit = (target: Element, ratio: number) =>
    intersect([
      {
        target,
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
      } as IntersectionObserverEntry,
    ]);
  let stop: (() => void) | undefined;
  try {
    stop = observeUnreadTimelineComments(
      root,
      new Map(comments.map((c) => [c.id, c])),
      () => unread,
      (comments) => {
        for (const c of comments) {
          reached.push(c.id);
          unread.delete(c.id);
        }
      }
    );
    expect(options[0]!.root).toBe(root);
    expect(observed.has(first)).toBe(true);
    emit(first, 0.2);
    expect(reached).toEqual([]);
    doc.visibilityState = "hidden";
    emit(first, 1);
    expect(reached).toEqual([]);
    doc.visibilityState = "visible";
    events.get("visibilitychange")!();
    emit(first, 1);
    expect(reached).toEqual(["first"]);
    expect(unread.has("reply")).toBe(true);
    elements.push(reply);
    mutate();
    expect(observed.has(reply)).toBe(true);
    emit(reply, 1);
    expect(reached).toEqual(["first", "reply"]);
    stop();
    expect(observed.size).toBe(0);
    expect(events.size).toBe(0);
    expect(mutationDisconnected).toBe(true);
  } finally {
    stop?.();
    globalThis.IntersectionObserver = originalIntersection;
    globalThis.MutationObserver = originalMutation;
  }
});
